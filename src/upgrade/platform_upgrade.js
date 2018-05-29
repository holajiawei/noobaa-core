/* Copyright (C) 2016 NooBaa */
"use strict";

const os = require('os');
const fs = require('fs');
const path = require('path');
const _ = require('lodash');

const pkg = require('../../package.json');
const dbg = require('../util/debug_module')(__filename);
const promise_utils = require('../util/promise_utils');
const fs_utils = require('../util/fs_utils');
const dotenv = require('../util/dotenv');
const os_utils = require('../util/os_utils');
const supervisor = require('../server/utils/supervisor_ctrl');

const EXTRACTION_PATH = '/tmp/test';
const CORE_DIR = '/root/node_modules/noobaa-core';
const NEW_VERSION_DIR = path.join(EXTRACTION_PATH, 'noobaa-core');
// use shell script for backup\restore so we won't be dependent in node version
const BACKUP_SCRIPT = path.join(CORE_DIR, 'src/upgrade/pre_upgrade_backup.sh');
const BACKUP_SCRIPT_NEW_PATH = path.join(EXTRACTION_PATH, 'pre_upgrade_backup.sh');
const HOME = '/root';
const NVM_DIR = `${HOME}/.nvm`;



const DOTENV_VARS_FROM_OLD_VER = Object.freeze([
    'JWT_SECRET',
    'PLATFORM',
    'DEV_MODE',
    'MONGO_RS_URL',
    'MONGO_SSL_USER',
]);

const EXEC_DEFAULTS = Object.freeze({
    ignore_rc: false,
    return_stdout: true,
    trim_stdout: true
});

// map process name (in ps) to service name (in supervisor.conf)
const SERVICES_INFO = Object.freeze([{
        srv: 'STUN',
        proc: 'turnserver',
        stop: true,
    },
    {
        srv: 'webserver',
        proc: 'web_server',
        stop: true,
    },
    {
        srv: 'bg_workers',
        proc: 'bg_workers',
        stop: true,
    },
    {
        srv: 'hosted_agents',
        proc: 'hosted_agents_starter',
        stop: true,
    },
    {
        srv: 's3rver',
        proc: 's3rver_starter',
        stop: true,
    },
    {
        srv: 'mongo_monitor',
        proc: 'mongo_monitor',
        stop: true,
    },
    {
        srv: 'upgrade_manager',
        proc: 'upgrade_manager',
        stop: false,
    },
    {
        srv: 'mongo_wrapper',
        proc: 'mongo_wrapper',
        stop: false,
    },
]);


async function services_to_stop() {
    const supervised_list = await supervisor.list();
    dbg.log0('UPGRADE: current services list is', supervised_list);

    // stop all services but upgrade_manager and mongo
    return supervised_list.filter(srv => (
        srv !== 'mongo_wrapper' &&
        srv !== 'upgrade_manager'));
}


async function stop_services() {
    // first stop all services in supervisor conf except those required for upgrade
    dbg.log0('UPGRADE: stopping services before upgrade');
    const srv_to_stop = await services_to_stop();
    dbg.log0('UPGRADE: stopping services:', srv_to_stop);
    await supervisor.stop(srv_to_stop);

    // now make sure that all the services to stop are actually stopped
    const procs = SERVICES_INFO
        .filter(info => srv_to_stop.includes(info.srv))
        .map(info => info.proc);
    const ps_services = await os_utils.get_services_ps_info(procs);
    if (ps_services.length > 0) {
        dbg.warn('UPGRADE: found services that should be down. killing them:', ps_services);
        ps_services.forEach(srv => {
            try {
                process.kill(Number.parseInt(srv.pid, 10), 'SIGKILL');
            } catch (err) {
                dbg.warn('failed killing process', srv);
            }
        });
    }

    // now make sure that there is no rouge 
}

async function start_services() {
    const stopped_services = await services_to_stop();
    dbg.log0('UPGRADE: starting services:', stopped_services);
    await supervisor.start(stopped_services);
}

async function run_platform_upgrade_steps() {
    if (!should_upgrade_platform()) return;

    // TODO: run platform upgrades more intelligently (according to previous version)
    await platform_upgrade_common();
    await platform_upgrade_2_4_0();
}

// platform upgrade for version 2.4.0
// * ensure swap is configured correctly in /etc/fstab
async function platform_upgrade_2_4_0() {
    await ensure_swap();
}

async function platform_upgrade_common(params) {
    await copy_first_install();
}

async function copy_first_install() {
    dbg.log0('UPGRADE: copying first_install_diaglog.sh and setting permissions');
    await exec(`cp -f ${CORE_DIR}/src/deploy/NVA_build/first_install_diaglog.sh /etc/profile.d/`);
    await exec(`chown root:root /etc/profile.d/first_install_diaglog.sh`);
    await exec(`chmod 4755 /etc/profile.d/first_install_diaglog.sh`);
}


function should_upgrade_platform() {
    return os.type() === 'Linux';
}



async function exec(command, options = {}) {
    try {
        dbg.log0('UPGRADE: executing command:', command);
        const stdout = await promise_utils.exec(command, EXEC_DEFAULTS);
        return stdout;
    } catch (err) {
        dbg.error('UPGRADE: got error when executing command', command, err);
        if (!options.ignore_err) throw err;
    }
}

async function ensure_swap() {

    const swap_conf = await fs_utils.find_line_in_file('/etc/fstab', 'swapfile');
    if (swap_conf) {
        dbg.log0('UPGRADE: swap is already configured in /etc/fstab');
        return;
    }

    const SWAP_SIZE_MB = 8 * 1024;

    try {
        const swap_summary = await exec(`swapon -s`);
        if (swap_summary) {
            dbg.log0('UPGRADE: setup_swap: Swap summary:', swap_summary);
        } else {
            dbg.log0('UPGRADE: setting up swap:');
            dbg.log0(`UPGRADE: allocate /swapfile of size ${SWAP_SIZE_MB}MB`);
            await exec(`dd if=/dev/zero bs=1M count=${SWAP_SIZE_MB} of=/swapfile`);
            await exec(`chmod 600 /swapfile`);
            dbg.log0(`UPGRADE: create and enable swap on /swapfile`);
            await exec(`mkswap /swapfile`);
            await exec(`swapon /swapfile`);
        }
        dbg.log0(`UPGRADE: configure swap in /etc/fstab`);
        await fs.appendFileAsync('/etc/fstab', '/swapfile\tswap\tswap\tsw\t0\t0\n');
    } catch (err) {
        dbg.error('UPGRADE: got error on setup_swap. swap might not be configured', err);
        throw err;
    }
}

async function set_new_node_version(ver) {
    try {
        await exec(`rm -f /usr/local/bin/node`);
        dbg.log0(`UPGRADE: pre_upgrade: Removed /usr/local/bin/node`);
        await exec(`ln -s ~/.nvm/versions/node/v${ver}/bin/node /usr/local/bin/node`);
        await exec(`. ${NVM_DIR}/nvm.sh;nvm alias default ${ver}`);
        await exec(`. ${NVM_DIR}/nvm.sh;nvm use ${ver}`);
    } catch (err) {
        dbg.error(`failed setting node version to ${ver}`, err);
        throw err;
    }
}

async function update_node_version() {

    let old_nodever;
    let nodever;
    try {
        nodever = (await fs.readFileAsync(`${EXTRACTION_PATH}/noobaa-core/.nvmrc`)).toString();
        old_nodever = (await fs.readFileAsync(`${CORE_DIR}/.nvmrc`)).toString();
        dbg.log0(`UPGRADE: old node version is ${old_nodever}. new node version is ${nodever}`);
        if (nodever === old_nodever) {
            dbg.log0(`UPGRADE: node version is not changed. skip node update`);
            return;
        }
    } catch (err) {
        dbg.warn('UPGRADE: failed getting node versions. abort', err);
        throw err;
    }

    await exec(`cp -f ${EXTRACTION_PATH}/noobaa-core/build/public/nvm.sh ~/.nvm/`);
    dbg.log0('UPGRADE: pre_upgrade: Copied nvm.sh');
    await exec(`chmod 777 ~/.nvm/nvm.sh`);
    dbg.log0('UPGRADE: pre_upgrade: Configured permissions to nvm.sh');

    dbg.log0('UPGRADE: pre_upgrade: Nodever', nodever);
    await fs_utils.create_fresh_path(`/tmp/v${nodever}`);
    dbg.log0(`UPGRADE: pre_upgrade: Created dir /tmp/v${nodever}`);
    await exec(`cp ${EXTRACTION_PATH}/noobaa-core/build/public/node-v${nodever}-linux-x64.tar.xz /tmp/`);
    dbg.log0(`UPGRADE: pre_upgrade: Copied node package`);
    await exec(`tar -xJf /tmp/node-v${nodever}-linux-x64.tar.xz -C /tmp/v${nodever} --strip-components 1`);
    dbg.log0(`UPGRADE: pre_upgrade: Extracted node package`);
    await exec(`mkdir -p ~/.nvm/versions/node/v${nodever}/`);
    dbg.log0(`UPGRADE: pre_upgrade: Created node dir`);
    await exec(`mv /tmp/v${nodever}/* ~/.nvm/versions/node/v${nodever}/`);
    dbg.log0(`UPGRADE: pre_upgrade: Moved node dir from /tmp to /.nvm`);

    // TODO: maybe backup the old node version in backup script
    try {
        await set_new_node_version(nodever);
    } catch (err) {
        dbg.error('failed when trying to set new node version. try to revert to version', old_nodever);
        await set_new_node_version(old_nodever);
        throw err;
    }
    dbg.log0('UPGRADE: pre_upgrade: Succeess');
}

async function platform_upgrade_init() {
    if (!should_upgrade_platform()) return;

    await update_node_version();
}

async function backup_old_version() {
    if (!should_upgrade_platform()) return;

    dbg.log0('UPGRADE: backing up old version platform files');
    // init to default backup script for old versions that did not implement
    let backup_script = path.join(NEW_VERSION_DIR, 'src/upgrade/default_upgrade_backup.sh');
    if (await fs_utils.file_exists(BACKUP_SCRIPT)) {
        backup_script = BACKUP_SCRIPT;
    }
    // copy backup script from current location to a new stable location
    await fs_utils.file_copy(backup_script, BACKUP_SCRIPT_NEW_PATH);
    await exec(`${backup_script}`);
    dbg.log0('UPGRADE: old version backed up successfully');
}

async function restore_old_version() {
    if (!should_upgrade_platform()) return;

    dbg.log0('UPGRADE: restoring back to old version');
    await exec(`${BACKUP_SCRIPT_NEW_PATH} restore`);
}

async function copy_new_code() {
    if (!should_upgrade_platform()) return;
    dbg.log0(`UPGRADE: deleting old code from ${CORE_DIR}`);
    await fs_utils.folder_delete(CORE_DIR);
    dbg.log0(`UPGRADE: copying ${NEW_VERSION_DIR} to ${CORE_DIR}`);
    await fs_utils.full_dir_copy(NEW_VERSION_DIR, CORE_DIR);
}

// make sure that all the file which are requiered by the new version (.env, etc.) are in the new dir
async function prepare_new_dir() {
    await _build_dotenv();
}

// build .env file in new version by taking all required env vars from old version
async function _build_dotenv() {
    dbg.log0('UPGRADE: generating dotenv file in the new version directory');
    const old_env = dotenv.parse(await fs.readFileAsync(`${CORE_DIR}/.env`));
    const new_env = Object.assign(
        dotenv.parse(await fs.readFileAsync(`${NEW_VERSION_DIR}/src/deploy/NVA_build/env.orig`)),
        _.pick(old_env, DOTENV_VARS_FROM_OLD_VER),
    );

    dbg.log0('UPGRADE: genertaing .env file for new version:', new_env);

    await fs.writeFileAsync(`${NEW_VERSION_DIR}/.env`, dotenv.stringify(new_env));
}

async function update_services() {
    // TODO: implement a good way to add\remove\update services from supervisor conf file without overriding
    // other changes (e.g. when creating a cluster we change noobaa_supervisor.conf)
    dbg.log0('UPGRADE: no updates to services in noobaa_supervisor.conf');
}

async function upgrade_mongodb_version(params) {
    // TODO: we should identify if mongodb should be upgraded to a new version. cluster upgrade should
    // be done onde by one (https://docs.mongodb.com/manual/release-notes/3.6-upgrade-replica-set/)
    dbg.log0('UPGRADE: skip mongodb version upgrade. mongodb should not be upgraded for this version');
}

async function get_mongo_shell_command(is_cluster) {
    let mongo_shell = '/usr/bin/mongo nbcore';
    if (is_cluster) {
        dbg.log0('UPGRADE: set_mongo_cluster_mode: Called');
        const rs_servers = await promise_utils.exec(`grep MONGO_RS_URL /root/node_modules/noobaa-core/.env | cut -d'@' -f 2 | cut -d'/' -f 1`, {
            ignore_rc: false,
            return_stdout: true,
            trim_stdout: true
        });
        dbg.log0(`UPGRADE: set_mongo_cluster_mode: MONGO_SHELL`, rs_servers);
        mongo_shell = `/usr/bin/mongors --host mongodb://${rs_servers}/nbcore?replicaSet=shard1`;
    }
    dbg.log0(`UPGRADE: using this mongo shell command: ${mongo_shell}`);
    return mongo_shell;

}

async function upgrade_mongodb_schemas(params) {
    const secret = await os_utils.read_server_secret();
    const MONGO_SHELL = await get_mongo_shell_command(params.is_cluster);
    const ver = pkg.version;

    async function set_mongo_debug_level(level) {
        await promise_utils.exec(`${MONGO_SHELL} --quiet --eval 'db.setLogLevel(${level})'`, {
            ignore_rc: false,
            return_stdout: true,
            trim_stdout: true
        });
    }

    dbg.log0(`UPGRADE: upgrading mongodb schemas. secret=${secret} ver=${ver} params=`, params);
    let UPGRADE_SCRIPTS = [];
    if (params.should_upgrade_schemas) {
        UPGRADE_SCRIPTS = [
            'mongo_upgrade_2_1_3.js',
            'mongo_upgrade_2_3_0.js',
            'mongo_upgrade_2_3_1.js',
            'mongo_upgrade_mark_completed.js'
        ];
    } else {
        UPGRADE_SCRIPTS = [
            'mongo_upgrade_wait_for_master.js'
        ];
    }

    // set mongo debug level
    await set_mongo_debug_level(5);

    for (const script of UPGRADE_SCRIPTS) {
        dbg.log0(`UPGRADE: Running Mongo Upgrade Script ${script}`);
        try {
            await promise_utils.exec(`${MONGO_SHELL} --eval "var param_secret='${secret}', version='${ver}'" ${CORE_DIR}/src/deploy/mongo_upgrade/${script}`, {
                ignore_rc: false,
                return_stdout: true,
                trim_stdout: true
            });

        } catch (err) {
            dbg.error(`Failed Mongo Upgrade Script ${script}`, err);
            await set_mongo_debug_level(0);
            throw err;
        }
    }

    await set_mongo_debug_level(0);

    dbg.log0('UPGRADE: upgrade_mongodb_schemas: Success');
}

async function after_upgrade_cleanup() {
    dbg.log0(`UPGRADE: deleting ${EXTRACTION_PATH}`);
    await fs_utils.folder_delete(`${EXTRACTION_PATH}`);
    await exec(`rm -f /tmp/*.tar.gz`, { ignore_err: true });
    await exec(`rm -rf /tmp/v*`, { ignore_err: true });
    await exec(`rm -rf /backup/build/public/*diagnostics*`, { ignore_err: true });
}



exports.run_platform_upgrade_steps = run_platform_upgrade_steps;
exports.platform_upgrade_init = platform_upgrade_init;
exports.backup_old_version = backup_old_version;
exports.restore_old_version = restore_old_version;
exports.copy_new_code = copy_new_code;
exports.prepare_new_dir = prepare_new_dir;
exports.update_services = update_services;
exports.upgrade_mongodb_version = upgrade_mongodb_version;
exports.upgrade_mongodb_schemas = upgrade_mongodb_schemas;
exports.after_upgrade_cleanup = after_upgrade_cleanup;
exports.stop_services = stop_services;
exports.start_services = start_services;