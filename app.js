var express = require('express');
var http = require('http');
var unirest = require('unirest');
var parse5 = require('parse5');
var xmlser = require('xmlserializer');
var dom = require('xmldom').DOMParser;
var xpath = require('xpath');

var app = express();
var enableBot = false;
var secret = process.env.SECRET;
var port = 3000;
var limit = 100;
var botToken = process.env.WWE_BOT_TOKEN;

/**
 * Long polling loop: Retrieves the received messages and provides an answer.
 * The received messages are processed using a pagination mechanism.
 * When received the secret keyword it stops.
 *
 * @see {@link https://core.telegram.org/bots/api#getupdates}
 *
 * @param offset the Id of the next message in the Telegram queue that must be processed
 * @param limit the number of messages that must be processed suring each iteration
 */
function getUpdates(offset, limit) {
    var url = 'https://api.telegram.org/bot'+botToken+'/getUpdates';
    unirest.post(url)
        .headers({'Accept': 'application/json', 'Content-Type': 'application/json'})
        .send({ "offset": offset, "limit": limit })
        .end(function (response) {
           /*
            *  Before disabling we need to notify as complete the updates computed in the last recursion.
            *  For this reason the following 'if' is put here (after the Telegram Bot API call).
            */
            if(!enableBot){
                return;
            }
            var updates = response.body.result;
            var maxUpdateId = 0;
            updates.forEach(function(update) {
                //console.log("*******\n "+JSON.stringify(update)+"*******");
                var chatId = update.message.chat.id;
                var firstName = update.message.from.first_name;
                var lastName = update.message.from.last_name;
                var from = firstName+" "+lastName;
                var text = update.message.text;
                var updateId = update.update_id;
                var entities = update.message.entities;


                if(updateId > maxUpdateId){
                    maxUpdateId = updateId;
                }

                var responseText;
                if(entities && entities[0].type == "bot_command"){
                    /* TODO: Improve commands switch*/
                    if(text.indexOf("/champions ") !== -1){
                        var roster = text.split(" ")[1];
                        scrapTitleHolderInformationFromWikipediaAndSendMessage(roster, chatId);
                    }
                }
                else{
                    if(text == secret){
                        console.log("[GETUPDS] Disabling...");
                        responseText = "Bye Bye... ";
                        enableBot = false; //Answers the messages in the buffer and then stops at the next recursive call
                    }
                    else{
                        responseText = "WHAT? Choose a command";
                    }
                    sendMessage(chatId, responseText);
                }
            });

            getUpdates(maxUpdateId+1, limit); //Recursion
        });
}

/**
 * Sends a message in a specific chat
 * @param chat_id the receiver chat
 * @param text the text that must be sent
 */
function sendMessage(chat_id, text) {
    var url = 'https://api.telegram.org/bot'+botToken+'/sendMessage';
    unirest.post(url)
        .headers({'Accept': 'application/json', 'Content-Type': 'application/json'})
        .send({ "chat_id": chat_id, "text": text })
        .end(function (response) {
           //console.log("[SENDMSG - OK] Message sent to chat: "+chat_id + " with text '"+text+"'");
            console.log("[SENDMSG - OK] Message sent to chat: "+chat_id);
        });
}

/**
 * Enables the bot. It starts the long polling loop
 */
app.get('/enable', function (req, res) {
    if(botToken && secret){
        console.log("[BOT] ENV VARS READ OK");
    }
    else{
        console.log("[BOT] ERR: ENV VARS NOT FOUND");
        res.sendStatus(500);
        return;
    }
    console.log("[BOT] Enabled!");
    enableBot = true;
    getUpdates(0, limit);
    res.sendStatus(200);
});

/**
 * Uses XPath to retrieve current title holders information from the Wikipedia page
 * @param roster The input roster. It can be 'raw', 'smackdown' or 'nxt'
 * @param chatId The id of the message requesting the information to the bot
 * @param responseText The response that must be sent to the chatId
 */
function scrapTitleHolderInformationFromWikipediaAndSendMessage(roster, chatId, responseText){
    var url = "https://en.wikipedia.org/wiki/List_of_current_champions_in_WWE";

    console.log("[scrapTitleHolderInformationFromWikipedia] Roster="+roster)
    unirest.get(url)
        .end(function (getResponse) {
            console.log("[WIKIPEDIA GET - OK] ");
            var document = parse5.parse(getResponse.body);
            var xhtml = xmlser.serializeToString(document);
            var doc = new dom().parseFromString(xhtml);
            var select = xpath.useNamespaces({"x": "http://www.w3.org/1999/xhtml"});
            //rawChampionsTableUnstructuredText = select("//x:div/x:textarea/text()", doc).toString();
            var nodes = select("//x:table[@class='wikitable']", doc);

            var champions = [];

            if(roster == 'raw'){
               var raw = new dom().parseFromString(nodes[0].toString());
               champions = extractRosterChampionsFromRosterTable(select, raw, 'RAW');
            }

            if(roster == 'smackdown'){
                var smackdown = new dom().parseFromString(nodes[1].toString());
                champions = extractRosterChampionsFromRosterTable(select, smackdown, 'Smackdown!');
            }

            if(roster == 'nxt'){
                var nxt = new dom().parseFromString(nodes[2].toString());
                champions = extractRosterChampionsFromRosterTable(select, nxt, 'NXT');
            }

            //console.log("[scrapTitleHolderInformationFromWikipedia] Sending title Holders--->\n\n" + JSON.stringify(champions));
            var responseText = getResponseMessageFromTitleHoldersJSON(champions);
            sendMessage(chatId, responseText);
        });
}

/**
 * Creates a formatted output string that is then sent to the client
 * @param champions Array of title holders. Each object is like {title: "Title Name", champion: "Champion Name"}
 * @returns {string} The response that can be sent to the client
 */
function getResponseMessageFromTitleHoldersJSON(champions){
    var responseMessage = "";

    champions.forEach(function (titleHolderData) {
        responseMessage += titleHolderData.title + ": " + titleHolderData.champion + "\n";
    });

    return responseMessage;
}

/**
 * Creates an array of title holders from the <tr>s coming from Wikipedia (extracted via XPath)
 * @param select XPath query
 * @param rosterTable HTML <table> code extracted from Wikipedia for the requested roster
 * @param rosterName requested roster name
 * @returns {Array} Array of title holders. Each object is like {title: "Title Name", champion: "Champion Name"}
 */
function extractRosterChampionsFromRosterTable(select, rosterTable, rosterName){
    /*
     * As per this issue https://github.com/goto100/xpath/issues/45
     * /table/tbody/tr/td[N] breaks the npm xpath (all the Nth tds of each tr)
     * the workaround is /table/tbody/tr/td[count(preceding-sibling::*) = N]
     */
    var rosterTitles =  select("/table/tbody/tr/td[count(preceding-sibling::*) = 0]/a/text()", rosterTable);
    var rosterChampions =  select("/table/tbody/tr/td[count(preceding-sibling::*) = 2]/a/text()", rosterTable);

    /*
    console.log("TITLES\n" + rosterTitles.toString());
    console.log("CHAMPIONS\n" + rosterChampions.toString());
    */

  /*
    if(rosterTitles.length != rosterChampions.length){
        console.log("ERROR: " + rosterName + " table-> the number of titles and champions don't match.");
        return "ERROR";
    }
    */

    var titleHolders = new Array();
    for(var i=0; i<rosterTitles.length; i++){
        //TODO: Fix the case where there is no <a> (e.g. Vacant)
        var titleHolder = {title: rosterTitles[i].toString(), champion: rosterChampions[i].toString()};
        titleHolders.push(titleHolder);
    }

    return titleHolders;
}

app.listen(port, function () {
    console.log('Doing magic on port ' + port);
});
