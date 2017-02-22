/* Copyright (C) 2016 NooBaa */
'use strict';

const P = require('../../util/promise');
const dbg = require('../../util/debug_module')(__filename);
const server_rpc = require('../server_rpc');
const RpcConnSet = require('../../rpc/rpc_conn_set');

const cluster_conn_set = new RpcConnSet('redirector cluster_conn_set');
const alerts_conn_set = new RpcConnSet('redirector alerts_conn_set');

function register_to_cluster(req) {
    cluster_conn_set.add(req.connection);
}

function publish_to_cluster(req) {
    const api_name = req.rpc_params.method_api.slice(0, -4); // remove _api suffix
    const method = req.rpc_params.method_name;
    const connections = cluster_conn_set.list();
    dbg.log0('publish_to_cluster:', connections.length);
    return P.map(connections,
            conn => server_rpc.client[api_name][method](req.rpc_params.request_params, {
                connection: conn,
                auth_token: req.auth_token,
            })
        )
        .then(res => ({
            redirect_reply: {
                aggregated: res,
            }
        }));
}

function register_for_alerts(req) {
    alerts_conn_set.add(req.connection);
}

function unregister_from_alerts(req) {
    alerts_conn_set.remove(req.connection);
}

function publish_alerts(req) {
    const connections = alerts_conn_set.list();
    dbg.log3('publish_alerts:', req.rpc_params.request_params, connections.length);
    return P.map(connections, conn =>
            server_rpc.client.frontend_notifications.alert(req.rpc_params.request_params, {
                connection: conn,
            })
        )
        .then(() => {
            dbg.log3('published');
        });
}


// EXPORTS
exports.register_for_alerts = register_for_alerts;
exports.unregister_from_alerts = unregister_from_alerts;
exports.register_to_cluster = register_to_cluster;
exports.publish_to_cluster = publish_to_cluster;
exports.publish_alerts = publish_alerts;
