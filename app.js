const bunyan = require('bunyan');
const pm2 = require('pm2');
const pmx = require('pmx');


const LOG_BLOCK_RE = /^\d\d\d\d-\d\d-\d\d \d\d:\d\d:\d\d \+\d\d:\d\d: (.*)/;
const LOG_RECORD_RE = /^\w\w\w, \d\d \w\w\w \d\d\d\d \d\d:\d\d:\d\d GMT (.*)/;

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
    var ret = [];
    
    var lines = packet.split('\n');
    
    var lastRecord;

    for (var i in lines) {
      var line = lines[i];
      var match = LOG_BLOCK_RE.exec(line);
      if (match) {
        line = match[1];
      }
      
      match = LOG_RECORD_RE.exec(line);
      if (match) {
        ret.push(lastRecord);
        lastRecord = match[1];
      } else {
        if (lastRecord) {
          lastRecord += '\n';
        }
        lastRecord += line;
      }
    }

    if (lastRecord) {
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
    var records = parseNodejsPacket(packet);
    for (var i in records) {
      var record = records[i];
      var message = record.message;
      delete record.message;
      switch (level) {
        case 'debug':
          log.debug(record, message);
          break;
        case 'info':
          log.info(record, message);
          break;
        case 'error':
          log.error(record, message);
          break;
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

      bus.on('log:PM2', logNodejsPackage.bind(null, 'debug'));
      bus.on('log:out', logNodejsPackage.bind(null, 'info'));
      bus.on('log:err', logNodejsPackage.bind(null, 'error'));
  });
});
