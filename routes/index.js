const express = require('express');
const router = express.Router();
const WebSocket = require('ws');
const fetch = require('node-fetch');
const cache = require('memory-cache');
const marked = require('marked');
const moment = require('moment');
const xss = require('xss');
const fs = require('fs');
const path = require('path');
const juice = require('juice');
const events = require('events');
const crypto = require('crypto');
const ejs = require('ejs');
const escape = require('escape-html');
const winston = require('winston');
var removeMd = require('remove-markdown');

const NODE_ENV = process.env.NODE_ENV || 'development';

var logger = new (winston.Logger)({
  level: NODE_ENV === 'development' ? "debug" : "error",
  transports: [
    new (winston.transports.Console)()
  ]
});

const PAD_REFRESH_INTERVAL = 4000;

// event emitter
const event = new events.EventEmitter();
event.setMaxListeners(20000);

// buffer html template
const html_template_path = path.join(__dirname, '../', 'ppau-responsive-html-email-template', 'email.html');
var html_template = fs.readFileSync(html_template_path, 'utf8');
var contentRegEx = new RegExp('(?:<!-- content_begin_marker -->)((?:.|\n)*)(?:<!-- content_end_marker -->)');
var logoRegEx = new RegExp('(?:<!-- logo_img_begin_marker -->)((?:.|\n)*)(?:<!-- logo_img_end_marker -->)');

html_template = html_template.replace(contentRegEx, "<!-- content_begin_marker --><%- markdownHtmlContent %><!-- content_end_marker -->");
html_template = html_template.replace(logoRegEx, "<img alt=\"Pirate Party Australia Logo\" width=\"350\" src=\"https://www.pirateparty.org.au/media/emails/2017/logos/logo350px.png\" />");

const pads = {};

var poll = function(padTicket, padName) {
  logger.info("poll() called with, ", padTicket, padName);
  var pad = pads[padName];
  if (!pad) {
    return;
  }

  if (pad.connections.length > 0) {
    logger.info("There are " + pad.connections.length + " subscribers for " + padName + ".");
    getRevision(pad);
  } else {
    logger.info("No subscribers for " + padName + ".");
  }
};

var getRevision = function(pad) {
  logger.info("getRevision() called with, pad=" + pad.name);
  return fetch('https://pad.pirateparty.org.au/p/' + pad.name + '/export/txt', {
      method: 'GET',
      credentials: "same-origin",
      headers: {
        'Content-Type': 'text/html'
      }
    })
    .then(function(res) {
      if (res.status === 200) {
        return res.text();
      }
      return Promise.reject(new Error("Pad server error"));
    }).then(function(text) {
      cache.put(pad.name + "-ticker", pad.name, PAD_REFRESH_INTERVAL, poll);
      cache.put(pad.name + "-value", text);

      const shasum = crypto.createHash('sha1');
      shasum.update(text);
      const digest = shasum.digest('hex');
      if (pad.sha1 !== digest){
        logger.info("pad has changed, notifying " + pad.connections.length + " clients.");
        pad.sha1 = digest;
        event.emit(pad.name);
      }

      return text;
    }).catch(function(ex) {
      logger.info("Failed collecting a pad for some reason", ex)
    });
};

var callToAction = function(text, url){
  return "<table border=\"0\" cellpadding=\"0\" cellspacing=\"0\" class=\"btn btn-primary\"> \
  <tbody>\
    <tr>\
      <td align=\"left\">\
        <table border=\"0\" cellpadding=\"0\" cellspacing=\"0\">\
          <tbody>\
            <tr>\
              <td> <a href=\"" + url + "\" target=\"_blank\">" + text + "</a> </td>\
            </tr>\
          </tbody>\
        </table>\
      </td>\
    </tr>\
  </tbody>\
</table>";
};

var callToActionText = function(text, url){
  return text + ": " + url;
};

var renderMarkdown = function(text){
  var re = /@\[(.*)]\((.*)\)/g;
  text = xss(text);
  text = text.replace(
    re,
    '<table border="0" cellpadding="0" cellspacing="0" class="btn btn-primary"><tbody><tr><td align="left"><table border="0" cellpadding="0" cellspacing="0"><tbody><tr><td><a href="$2" target="_blank">$1</a></td></tr></tbody></table></td></tr></tbody></table>'
  );
  text = marked(text);
  return text;
};

var renderText = function(text){
  var reCallToAction = /@\[(.*)]\((.*)\)/g;
  var reLink = /\[(.*)]\((.*)\)/g;
  text = xss(text);

  // Call to action buttons
  text = text.replace(
    reCallToAction,
    '$1: $2'
  );

  // Links
  text = text.replace(
    reLink,
    '$1 ( $2 )'
  );

  text = removeMd(text, { stripListLeaders: false, gfm: false});
  text = text.replace('\\\*', '*');
  return text;
};

router.get('/', function(req, res, next) {
  res.render('index', { title: 'EmailPad', pad: null });
});

router.get('/load/:pad', function(req, res, next) {
  var context = {
    pad: !!req.params.pad ? req.params.pad : null
  };
  res.render('index', context);
});

router.get('/right/:pad', function(req, res, next) {

  var context = {
    pad: !!req.params.pad ? req.params.pad : null
  };
  res.render('right', context);
});

router.get('/render-html/:pad', function(req, res, next) {
  var text = cache.get(req.params.pad + "-value");
  if (!text) {
    text = '';
  } else {
    text = renderMarkdown(text);
  }

  var context = {
    pad: !!req.params.pad ? req.params.pad : null,
    markdownHtmlContent: text
  };
  res.render('email-html', context);
});

router.get('/render-pre/:pad', function(req, res, next) {
  var text = cache.get(req.params.pad + "-value");
  if (!text) {
    text = '';
  } else {
    text = renderMarkdown(text);
  }

  var context = {
    pad: !!req.params.pad ? req.params.pad : null,
    markdownHtmlContent: text
  };

  const template = ejs.compile(html_template, {});
  const render = template(context);
  var renderCssInline = juice(render, {});

  if (req.query.dada === "true") {
    const match = renderCssInline.match(contentRegEx);
    renderCssInline = match[1];
  }

  context.markdownHtmlContent = escape(renderCssInline);

  //res.send(renderCssInline); // debugging, this was not easy...
  res.render('email-pre', context);
});

router.get('/render-text/:pad', function(req, res, next) {
  var text = cache.get(req.params.pad + "-value");
  text = !text ? '' : text;
  text = renderText(text);

  var context = {
    pad: !!req.params.pad ? req.params.pad : null,
    markdownTextContent: xss(text)
  };
  res.render('email-text', context);
});

// Socket eventing for updates
router.ws('/sockets/:padName', function(ws, req) {
  logger.info('New connection for:', req.url);

  var padName = req.params.padName;
  var pad = pads[padName] || {
    connections: [],
    name: padName,
    sha1: null,
  };
  pads[padName] = pad;
  pad.connections.push(ws);
  var first = pad.connections.length === 1;
  if (first) {
    poll(null, padName);
  }

  // Notifies the connection when the pad changes.
  const padChangeEventHandler = function() {
    if (ws.readyState !== WebSocket.OPEN) {
      return
    }
    ws.send('refresh');
  };
  event.on(padName, padChangeEventHandler);

  ws.on('message', function(clientMessage) {
    logger.info("client requesting: ", clientMessage);
  });

  ws.on('close', function() {
    logger.info("client closed connection.");
    if (pad.connections.indexOf(ws) >= 0){
      logger.info("connection removed from pad refresh subscribers.");

      // clean ups.
      pad.connections.splice(pad.connections.indexOf(ws), 1);
      event.removeListener(padName, padChangeEventHandler);
    }
  });
});

var socketsBroadcast = function() {
  logger.info("socketsBroadcast() called", pads);
  event.emit('ping');
};

module.exports = router;