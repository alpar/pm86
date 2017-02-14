/* jshint node: true */
'use strict';

import connectdb from './helpers/MongoDBPool';

var axon = require('axon');
var sock = axon.socket('pull');
var Cipher = require('./Cipher.js');
var util = require('util');
var falconService = require('./PushFalconService');
var dbConnName = 'writeDBConn'; // MongoDB读写线程池分离
var rpc = require('axon-rpc');
var req = axon.socket('req');
var rpcClient = new rpc.Client(req);

async function insertStatusByQuery(query, statusCollection) {
    try {
        return await statusCollection.insertAsync(query);
    } catch(e) {
        console.error(e);
    }
}

async function findOneBucketByQuery(query, bucketsCollection) {
    try {
        return await bucketsCollection.findOneAsync(query);
    } catch(e) {
        console.error(e);
    }
}

async function findSessionByQuery(query, sessionsCollection) {
    try {
        return await sessionsCollection.findOneAsync(query);
    } catch(e) {
        console.error(e);
    }
}

async function insertProcess(msg, secret_key) {
    msg.data = Cipher.decipherMessage(msg.data, secret_key);
    msg.created_at = new Date();

    if(msg.data === null || !msg.data) {
        return console.error(new Error('insertProcess:decipherMessageFailed:' + secret_key));
    }

    for(var process in msg.data.monitoring.processes) {
        if(msg.data.monitoring.processes.hasOwnProperty(process)) {
            if(process.match(/\./igm)) {
                msg.data.monitoring.processes[process.replace(/\./igm, '-')] = msg.data.monitoring.processes[process];
                delete msg.data.monitoring.processes[process];
            }
        }
    }

    // 从数据中剥离进程事件插入到独立的Collection
    if(msg.data.hasOwnProperty('process:event')) {
        insertExtendInfo(msg.data['process:event'], msg.public_key, msg.data.server_name, 'events', 'event');
    }

    // 从数据中剥离进程异常信息插入到独立的Collection
    if(msg.data.hasOwnProperty('process:exception')) {
        insertExtendInfo(msg.data['process:exception'], msg.public_key, msg.data.server_name, 'exceptions', 'exception');
    }

    // 从数据中剥离服务整体监控指标插入到独立的Collection
    if(msg.data.hasOwnProperty('monitoring')) {
        insertExtendInfo(msg.data['monitoring'], msg.public_key, msg.data.server_name, 'monitorings', 'monitoring');
    }

    // 从数据中剥离HTTP传输信息插入到独立的Collection
    if(msg.data.hasOwnProperty('http:transaction')) {
        if(Array.isArray(msg.data['http:transaction'])) {
            msg.data['http:transaction'].forEach(function(transaction, index, arr) {
                insertExtendInfo(transaction, msg.public_key, msg.data.server_name, 'transactions', 'transaction');
            });
        }
    }

    // console.log(msg.data)
    var db = await connectdb(dbConnName);
    var status = db && db.collection('status');
    var query = {
        'public_key': msg.public_key,
        'data.server_name': msg.data.server_name
    };

    // 设置TTL确保数据入库后只保存7天时间
    var ensureTTL = await status.ensureIndexAsync({'created_at': 1}, {expireAfterSeconds: 3600 * 24 * 7});

    // 插入当前收集到的数据到总的结果集
    var result = await insertStatusByQuery(msg, status);

    falconService.pushData(msg.data);
    db && db.close();
    return result;
};

async function insertExtendInfo(data, public_key, server_name, collection_name, field_name) {
    var db = await connectdb(dbConnName);
    var status = db && db.collection(collection_name);
    var data = {
        'public_key': public_key,
        'sent_at': new Date().getTime(),
        'created_at': new Date(),
        'data': {
            'server_name': server_name,
            [field_name]: data
        }
    };

    var result = await insertStatusByQuery(data, status);

    // 设置TTL确保数据入库后只保存7天时间
    var ensureTTL = await status.ensureIndexAsync({'created_at': 1}, {expireAfterSeconds: 3600 * 24 * 7});

    db && db.close();
};

async function messageHandler(msg, data) {

    try {
        msg = JSON.parse(msg);
    } catch(e) {
        console.error(new Error('messageParseError'));
        return;
    }
    console.time('PullInteractorService:messageHandler');
    var db = await connectdb(dbConnName);

    if(!db) return;

    var buckets = db && db.collection('buckets');
    var query = { public_key: msg.public_key };
    // console.log(query);
    var doc = await findOneBucketByQuery(query, buckets);

    if(!doc) {
        console.error(new Error('publicKeyNotFound.'));
        db && db.close();
        return;
    }

    if(data && (msg.heapdump || msg.cpuprofile)) {
        profilingProcess(msg, data);
        console.timeEnd('PullInteractorService:messageHandler');
        db && db.close();
        return;
    }

    insertProcess(msg, doc.secret_key);
    console.timeEnd('PullInteractorService:messageHandler');
    db && db.close();
}

function profilingProcess(msg, data) {
    var path = require('path');
    var fs = require('fs');
    var fileName = `${msg.server_name}.${msg.public_key}.${msg.name}.${msg.pm_id}`;

    console.time('PullInteractorService:profilingProcess');

    if(msg.heapdump) {
        fileName = fileName + '.heapsnapshot';
    }

    if(msg.cpuprofile) {
        fileName = fileName + '.cpuprofile';
    }

    try {
        if(!fs.existsSync(path.join(process.env.PWD, 'profilings'))) {
            fs.mkdirSync(path.join(process.env.PWD, 'profilings'));
        }

        fs.writeFileSync(path.join(process.env.PWD, 'profilings', fileName), data);

        console.log('PullInteractorService:profilingProcess:rpcClient.call');
        rpcClient.call('profiling', msg.server_name, msg.public_key, {
            status: 'success',
            server_name: msg.server_name,
            public_key: msg.public_key,
            name: msg.name,
            pm_id: msg.pm_id,
            heapdump: msg.heapdump,
            cpuprofile: msg.cpuprofile,
            file_name: fileName,
            timestamp: Date.now()
        }, function(error) {
            error && console.error(error);
        });
    } catch (e) {
        console.error(e.stack || e);
    }

    console.timeEnd('PullInteractorService:profilingProcess');
}

sock.bind(8080);
sock.on('message', messageHandler.bind(sock));
sock.on('process:exception', function() {});
req.connect(43666);
