'use strict';

const bunyan = require('bunyan');
const pm2 = require('pm2');
const pmx = require('pmx');


const LOG_BLOCK_RE = /^\d\d\d\d-\d\d-\d\d \d\d:\d\d:\d\d \+\d\d:\d\d: (.*)/;
const LOG_RECORD_RE = /^\w\w\w, \d\d \w\w\w \d\d\d\d \d\d:\d\d:\d\d GMT (.*)/;

// www & front
const LOG_WWW_RECORD_RE = /^::ffff:127\.0\.0\.1 - - \[\w\w\w, \d\d \w\w\w \d\d\d\d \d\d:\d\d:\d\d GMT\](.*)/;

// media_saver & media_transcoder
const LOG_MEDIA_RECORD_RE = /^(\w+)\s([^\s]+)\s(.*)$/;
const LOG_MEDIA_RECORD_WITH_DATE_RE = /^\d\d\d\d-\d\d-\d\d \d\d:\d\d:[\d.]+:\s(\w+)\s([^\s]+)\s(.*)$/;

// broadcaster
const LOG_BROADCAST_RECORD_RE = /^\d\d\d\d-\d\d-\d\d \d\d:\d\d:\d\d:\d\d\d FileStreamer\[\d+:\d+\] ([\s\S]*)$/;
const BROADCASTER_APPS = ['test_facebook', 'test_youtube', 'test_fan', 'staging_facebook', 'staging_youtube', 'staging_fan', 'prod_facebook', 'prod_youtube', 'prod_fan'];
pmx.initModule({
  widget: {
    logo: 'http://semicomplete.com/presentations/logstash-monitorama-2013/images/elasticsearch.png',
    theme: ['#141A1F', '#222222', '#3ff', '#3ff'],
    el: {
      probes: false,
      actions: false
    },
    block: {
      actions: false,
      issues: false,
      meta: false,
    }
  }
}, (err, conf) => {
  if (err) {
      console.log('error', err);
      return;
  }

  const amqpStream = require('bunyan-logstash-amqp').createStream({
    port: conf.amqpPort || 5672,
    host: conf.amqpHost,
    vhost: conf.amqpVhost || 'sandbox',
    exchange: {
      name: conf.amqpExchange,
      routingKey: conf.amqpRoutingKey
    },
    login: conf.amqpUser,
    password: conf.amqpPasswd
  })
    .on('connect', () => console.log('Connected to amqp [module]'))
    .on('close', () => console.log('Closed connection to amqp'))
    .on('error', console.log);

  const log = bunyan.createLogger({
    name: conf.logName,
    streams: [{
      level: conf.logLevel,
      type: 'raw',
      stream: amqpStream
    }],
    level: conf.logLevel
  });


  function parseNodejsPacket(packet) {
    const ret = [];

    const lines = packet.data.split('\n');

    let lastRecord = '';

    for (const i in lines) {
      let line = lines[i];
      let match = LOG_BLOCK_RE.exec(line);
      if (match) {
        line = match[1];
      }

      match = LOG_RECORD_RE.exec(line);
      if (!match) {
        match = LOG_WWW_RECORD_RE.exec(line);
      }

      if (match) {
        ret.push(lastRecord);
        lastRecord = match[1];
      } else {
        if (lastRecord !== '') {
          lastRecord += '\n';
        }
        lastRecord += line.trim();
      }
    }

    if (lastRecord !== '') {
      ret.push(lastRecord);
    }

    return ret.map(function(record) {
      return {
        app: packet.process.name,
        message: record
      };
    });
  }

  function logNodejsPacket(level, packet) {
    const records = parseNodejsPacket(packet);

    for (const recordIndex in records) {
      const record = records[recordIndex];

      if (record.message == null || record.message === '') {
        continue;
      }

      const messages = [];

      if (record.app === 'media_saver' || record.app === 'media_transcoder') {
        const lines = record.message.split('\n');
        let lvl;

        for (const lineIndex in lines) {
          const line = lines[lineIndex];
          let match = LOG_MEDIA_RECORD_WITH_DATE_RE.exec(line);
          if (!match) {
            match = LOG_MEDIA_RECORD_RE.exec(line)
          }
          if (match) {
            lvl = match[1];
            messages.push(match[3]);
          } else {
            if (messages.length === 0) {
              messages.push('');
            }
            messages[messages.length - 1] += '\n' + line;
          }
        }
        level = lvl || 'debug';
      } if (BROADCASTER_APPS.indexOf(record.app) >= 0) {
        const match = LOG_BROADCAST_RECORD_RE.exec(record.message.trim());
        messages.push(match ? match[1] : record.message);
        level = 'info';
      } else {
        if (record.app === 'front' || record.app === 'www') {
          const msgFirstLine = record.message.split('\n')[0];
          switch (msgFirstLine) {
            case 'Error: Not Found':
            case 'Error: Unauthorized':
            case 'Error: Could not authenticate you.':
              level = 'warning';
              break;
          }
          switch (msgFirstLine.split(',')[0]) {
            case 'Error: cannot join session in inappropriate state':
            case 'Error: no session runners':
              level = 'warning';
              break;
          }
        }
        messages.push(record.message);
      }

      delete record.message;

      if (conf.myHost) {
        record.host = conf.myHost;
      }

      if (conf.myProject) {
        record.project = conf.myProject;
      }

      if (conf.myEnv) {
        record.env = conf.myEnv;
      }

      for (const messageIndex in messages) {
        const message = messages[messageIndex];
        switch (level) {
          case 'debug':
            log.debug(record, message);
            break;
          case 'info':
            log.info(record, message);
            break;
          case 'warn':
          case 'warning':
            log.warn(record, message);
            break;
          case 'error':
            log.error(record, message);
            break;
          default:
            log.info(record, message);
        }
      }
    }
  }

  pm2.connect((err) => {
    if (err) {
        console.log('error', err);
        return;
    }

    console.log('info', 'PM2: forwarding to amqp');

    pm2.launchBus((err, bus) => {
      if (err) {
          console.log('error', err);
          return;
      }

      bus.on('log:PM2', logNodejsPacket.bind(null, 'debug'));
      bus.on('log:out', logNodejsPacket.bind(null, 'info'));
      bus.on('log:err', logNodejsPacket.bind(null, 'error'));
    });
  });
});
