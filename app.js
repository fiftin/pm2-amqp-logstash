'use strict';

const bunyan = require('bunyan');
const pm2 = require('pm2');
const pmx = require('pmx');
const os = require('os');
const exec = require('child_process').exec;
const parse = require('parse_scala_log');
const extend = require('xtend');

const LOG_BLOCK_RE = /^\d\d\d\d-\d\d-\d\d \d\d:\d\d:\d\d \+\d\d:\d\d: (.*)/;
const LOG_RECORD_RE = /^\w\w\w, \d\d \w\w\w \d\d\d\d \d\d:\d\d:\d\d GMT (.*)/;

const LOG_LIVE_RECORD_RE = /^\d\d\d\d-\d\d-\d\d \d\d:\d\d:\d\d\.\d\d\d\s+(\w+)\s+(.*)/;

// www & front
const LOG_WWW_RECORD_RE = /^::ffff:127\.0\.0\.1 - - \[\w\w\w, \d\d \w\w\w \d\d\d\d \d\d:\d\d:\d\d GMT\](.*)/;

// media_saver & media_transcoder
const LOG_MEDIA_RECORD_RE = /^(\w+)\s([^\s]+)\s(.*)$/;
const LOG_MEDIA_RECORD_WITH_DATE_RE = /^\d\d\d\d-\d\d-\d\d \d\d:\d\d:[\d.]+:\s(\w+)\s([^\s]+)\s(.*)$/;

// live
const LOG_LIVE_STATS_RE = /Relay ([\w\-\d]+) statistics OutboundStatisticsPacket/;
const LOG_LIVE_RELAYS_RE = /Requested statistics from (\d+) relay\(s\)/;
const LOG_LIVE_STATS2_RE = /c\.v\.m\.runners\.LiveManager\$\$anon\$1 LiveManager\$\$anon\$1\(akka:\/\/runner\) - Stream.in(\d+)\(\d+\) Received/;
// red5
const LOG_RED5_RE = /^\[(\w+)] \[(\w+-\d+)] ([\w.]+) - (.+)$/;
const LOG_RED5_IGNORED = [
  'No streaming proxy present. Ignore'
];
// broadcaster
//const LOG_BROADCAST_RECORD_RE = /^\d\d\d\d-\d\d-\d\d \d\d:\d\d:\d\d:\d\d\d FileStreamer\[\d+:\d+\] ([\s\S]*)$/;
//const BROADCASTER_APPS = ['test_facebook', 'test_youtube', 'test_fan', 'staging_facebook', 'staging_youtube', 'staging_fan', 'prod_facebook', 'prod_youtube', 'prod_fan'];


function getStatistics() {
  return new Promise(function(resolve, reject) {
    const ret = {};
    ret.freeMemory = os.freemem();
    ret.totalMemory = os.totalmem();
    ret.usedMemory = ret.totalMemory - ret.freeMemory;

    ret.freeMemoryGb = Math.floor(ret.freeMemory / 1000000000);
    ret.totalMemoryGb = Math.floor(ret.totalMemory / 1000000000);
    ret.usedMemoryGb = Math.floor(ret.usedMemory / 1000000000);

    ret.usedMemoryPct = Math.floor((ret.usedMemory / ret.totalMemory) * 100);

    pm2.list(function(err, list) {
      ret.processes = {};
      ret.processesMemory = 0;
      ret.processesCPU = 0;

      list.forEach(function(x) {
        const name = x.name;
        const proc = x.monit;
        ret.processesMemory += proc.memory;
        ret.processesCPU += proc.cpu;
        proc.name = name;
        proc.memoryMb = Math.floor(proc.memory / 1000000);
        proc.restartTime = x.pm2_env.restart_time;
        proc.status = x.pm2_env.status;
        proc.createdAt = new Date(x.pm2_env.created_at).toISOString();
        proc.pmUptime = new Date(x.pm2_env.pm_uptime).toISOString();

        proc.uptimeMins = Math.floor((new Date() - new Date(x.pm2_env.pm_uptime)) / (1000 * 60));
        proc.uptimeHours = Math.floor((new Date() - new Date(x.pm2_env.pm_uptime)) / (1000  * 60 * 60));
        proc.uptimeDays = Math.floor((new Date() - new Date(x.pm2_env.pm_uptime)) / (1000  * 60 * 60 * 24));

        if (ret.processes[name]) {
          if (!Array.isArray(ret.processes[name])) {
            ret.processes[name] = [ret.processes[name]];
          }
          ret.processes[name].push(proc);
        } else {
          ret.processes[name] = proc;
        }
      });

      ret.processesMemoryMb = Math.floor(ret.processesMemory / 1000000);

      exec('df /', function(error, stdout, stdrrr) {
        if (error) {
          console.log('Disk Space Resolving Error: ' + error);
          ret.spaceResolvingError = error;
          resolve(ret);
          return;
        }
        const info = stdout.split('\n')[1].split(/\s+/);

        ret.usedSpaceKb = parseInt(info[2]);
        ret.availableSpaceKb = parseInt(info[3]);
        ret.totalSpaceKb = ret.usedSpaceKb + ret.availableSpaceKb;

        ret.usedSpaceGb = Math.floor(ret.usedSpaceKb / 1000000);
        ret.availableSpaceGb = Math.floor(ret.availableSpaceGb / 1000000);
        ret.totalSpaceGb = Math.floor(ret.totalSpaceKb / 1000000);

        ret.usedSpacePct = parseInt(info[4].replace('%', ''));
        resolve(ret);
      });
    });
  });
}


function parseNodeJsPacket(packet) {
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

function isBroadcasterApp(record) {
  return record.host === 'broadcaster';
  //return BROADCASTER_APPS.indexOf(record.app) >= 0;
}

function logNodeJsPacket(log, conf, level, packet) {
  const records = parseNodeJsPacket(packet);

  for (const recordIndex in records) {
    const record = records[recordIndex];

    if (record.message == null || record.message === '') {
      continue;
    }

    if (conf.myHost) {
      record.host = conf.myHost.split('.')[0];
    }

    if (conf.myProject) {
      record.project = conf.myProject;
    }

    if (conf.myEnv) {
      record.env = conf.myEnv;
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
      if (level !== 'error') {
        return;
      }
    } if (isBroadcasterApp(record)) {
      //const match = LOG_BROADCAST_RECORD_RE.exec(record.message.trim());
      //messages.push(match ? match[1] : record.message);
      //level = 'info';
      return;
    } else if (record.app === 'live' || record.app === 'manager') {
      const match = LOG_LIVE_RECORD_RE.exec(record.message.trim());
      messages.push(match ? match[2] : record.message);
      level = match ? match[1].toLowerCase() : 'info';
      const stats = LOG_LIVE_STATS_RE.exec(record.message.trim()) || LOG_LIVE_STATS2_RE.exec(record.message.trim());
      const relays = LOG_LIVE_RELAYS_RE.exec(record.message.trim());
      if (stats) {

        let str = record.message.trim().replace(/\(Ballast Video ([^)]+)\)/g, '');
        let startIndex = str.indexOf('OutboundStatisticsPacket');
        let isStats2 = false;
        if (startIndex === -1) {
          isStats2 = true;
          startIndex = str.indexOf('InboundNotifications');
        }

        str = str.substring(startIndex);
        try {
          let obj = parse(str);

          if (isStats2) {
            obj = obj.notifications.notifications[0].content.value;
            obj.statistic = obj.broadcast;
          }

          const relayNameEndIndex = stats[1].lastIndexOf('-');
          const layerTargets = {
            Audio: 0,
            Video100kbps: 0,
						Video200kbps: 0,
            Video300kbps: 0,
            Video500kbps: 0,
						Video600kbps: 0,
						Video700kbps: 0,
            Video1000kbps: 0,
						Video1200kbps: 0,
						Video1300kbps: 0,
            Video1500kbps: 0,
						Video2000kbps: 0
          };

          for (const session of obj.statistic.sessions) {
            for (const stream of session.streams) {
              for (const layer of stream.layers) {
                if (layerTargets[layer.mediaLayer] == null) {
                  layerTargets[layer.mediaLayer] = 0;
                }
                layerTargets[layer.mediaLayer] += parseInt(layer.targetsCount);
              }
            }
          }
          
          record.relay = {
            name: stats[1].substring(0, relayNameEndIndex),
            usersCount: parseInt(obj.usersCount),
            outputKbps: obj.statistic && obj.statistic.network ? parseInt(obj.statistic.network.Network.outputKbps) : 0,
            skipKbps: obj.statistic && obj.statistic.network ? parseInt(obj.statistic.network.Network.averageUser.skipKbps) : 0,
            outputPerUserKbps: obj.statistic && obj.statistic.network ? parseInt(obj.statistic.network.Network.averageUser.outputKbps) : 0,
            layerTargets: layerTargets  
          };
        } catch(e) {
          console.log('Scala log parse error: ');
          console.log(e);
          console.log('^^^^^^^^^^^^^^^^^^^^^^^');
          console.log(str);
        }
      } else if (relays) {
        record.numberOfRelays = parseInt(relays[1]);
      }
    } else if (record.app === 'red5') {
      const lines = record.message.split('\n');
      for (const i in lines) {
        const line = lines[i];
        let ignored = false;
        for (const s of LOG_RED5_IGNORED) {
          if (line.indexOf(s) !== -1) {
            ignored = true;
            break;
          }
        }
        if (ignored) {
          continue;
        }
        const m = line.match(LOG_RED5_RE);
        if (!m) {
          messages.push(line);
        } else {
          messages.push({
            level: m[1],
            thread: m[2],
            package: m[3],
            message: m[4]
          });
        }
      }
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
    for (const messageIndex in messages) {
      let message;
      if (typeof messages[messageIndex] === 'string') {
        message = messages[messageIndex];
      } else {
        message = messages[messageIndex].message;
        record.package = messages[messageIndex].package;
        record.thread = messages[messageIndex].thread;
      }
      if (message === '') {
        continue;
      }
      switch (messages[messageIndex].level || level) {
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


// Init pm2 module
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

  // Connect to RabbitMQ
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
  }).on('connect', () => console.log('Connected to amqp [module]'))
    .on('close', () => console.log('Closed connection to amqp'))
    .on('error', console.log);


  // Create logger
  const log = bunyan.createLogger({
    name: conf.logName,
    streams: [{
      level: conf.logLevel,
      type: 'raw',
      stream: amqpStream
    }],
    level: conf.logLevel
  });


  // Send statistics to logstash
  setInterval(function() {
    getStatistics().then(function(stats) {
      stats.app = 'stats';
      if (conf.myHost) {
        stats.host = conf.myHost.split('.')[0];
      }
      if (conf.myProject) {
        stats.project = conf.myProject;
      }
      if (conf.myEnv) {
        stats.env = conf.myEnv;
      }
      log.info(stats);
    });
  }, 30000);


  // Send pm2 logs to logstash
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

      bus.on('log:PM2', logNodeJsPacket.bind(null, log, conf, 'debug'));
      bus.on('log:out', logNodeJsPacket.bind(null, log, conf, 'info'));
      bus.on('log:err', logNodeJsPacket.bind(null, log, conf, 'error'));
    });
  });
});
