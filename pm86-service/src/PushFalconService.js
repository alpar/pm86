/* jshint node: true */
'use strict';

var Falcon = require('open-falcon').init('http://127.0.0.1:41624', 'pm86');
var falcon = new Falcon({ step: 60 });
var NodeCache = require('node-cache');
var metricsCache = new NodeCache({ stdTTL: 60, checkperiod: 80 });

function pushDataHandler(data, options = undefined) {
    // 确保一分钟内同一个节点的所有指标只向Falcon上报一次
    if(metricsCache.get(data.server_name) === true) {
        return;
    }

    metricsCache.set(data.server_name, true);

    options = {
        type: 'pm86',
        server_name: data.server_name,
        endpoint: data.server_name.split('.')[0]
    };

    if(!data.monitoring['req/sec']) {
        data.monitoring['req/sec'] = 0;
    }

    if(!data.monitoring['current_req_processed']) {
        data.monitoring['current_req_processed'] = 0;
    }

    if(!data.monitoring['restart_time']) {
        data.monitoring['restart_time'] = 0;
    }

    if(!data.monitoring['pmx_http_latency']) {
        data.monitoring['pmx_http_latency'] = 0;
    }

    for(var i = 0; i < data.status.data.process.length; i++) {
        var process = data.status.data.process[i];

        falcon
            .gauge('pm86.process.' + process.pm_id + '.restart_time', process.restart_time, options)
            .gauge('pm86.process.' + process.pm_id + '.status', process.status, options)
            .gauge('pm86.process.' + process.pm_id + '.cpu', process.cpu, options)
            .gauge('pm86.process.' + process.pm_id + '.memory', process.memory, options);

        data.monitoring['restart_time'] = data.monitoring['restart_time'] + process.restart_time;

        if(process.axm_monitor) {
            if(process.axm_monitor['req/sec']) {
                falcon.gauge('pm86.process.' + process.pm_id + '.req/sec', process.axm_monitor['req/sec'].value, options);
                data.monitoring['req/sec'] = data.monitoring['req/sec'] + Number(process.axm_monitor['req/sec'].value);
            }

            if(process.axm_monitor['Current req processed']) {
                falcon.gauge('pm86.process.' + process.pm_id + '.current_req_processed', process.axm_monitor['Current req processed'].value, options);
                data.monitoring['current_req_processed'] = data.monitoring['current_req_processed'] + Number(process.axm_monitor['Current req processed'].value);
            }

            if(process.axm_monitor['pmx:http:latency']) {
                falcon.gauge('pm86.process.' + process.pm_id + '.pmx_http_latency', parseFloat(process.axm_monitor['pmx:http:latency'].value), options);
                data.monitoring['pmx_http_latency'] = data.monitoring['pmx_http_latency'] + parseFloat(process.axm_monitor['pmx:http:latency'].value);
            }
        }
    }

    if(data.monitoring) {
        falcon
            .gauge('pm86.monitoring.loadavg.1min', data.monitoring.loadavg[0], options)
            .gauge('pm86.monitoring.loadavg.5min', data.monitoring.loadavg[1], options)
            .gauge('pm86.monitoring.loadavg.20min', data.monitoring.loadavg[2], options)
            .gauge('pm86.monitoring.total_mem', data.monitoring.total_mem, options)
            .gauge('pm86.monitoring.free_mem', data.monitoring.free_mem, options)
            .gauge('pm86.monitoring.req/sec', data.monitoring['req/sec'], options)
            .gauge('pm86.monitoring.current_req_processed', data.monitoring.current_req_processed, options)
            .gauge('pm86.monitoring.pmx_http_latency', data.monitoring.pmx_http_latency, options)
            .gauge('pm86.monitoring.restart_time', data.monitoring.restart_time, options);
    }

    return data;
}

module.exports = {
    pushData: pushDataHandler
};
