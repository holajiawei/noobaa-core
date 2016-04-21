'use strict';

let _ = require('lodash');
let P = require('../../util/promise');
let db = require('../db');
let mongodb = require('mongodb');
let mongo_utils = require('../../util/mongo_utils');
let nodes_store = require('../stores/nodes_store');
// let dbg = require('../../util/debug_module')(__filename);

module.exports = {
    load_chunks_by_digest: load_chunks_by_digest,
    load_blocks_for_chunks: load_blocks_for_chunks,
    load_jenia_magic_for_chunks: load_jenia_magic_for_chunks,
    make_md_id: make_md_id,
};

function load_chunks_by_digest(bucket, digest_list) {
    let chunks;
    return P.when(db.DataChunk.collection.find({
            system: bucket.system._id,
            bucket: bucket._id,
            digest_b64: {
                $in: digest_list
            },
            deleted: null,
            building: null
        }, {
            sort: {
                _id: -1 // get newer chunks first
            }
        }).toArray())
        .then(res => {
            chunks = res;
            return load_blocks_for_chunks(chunks);
        })
        .then(blocks => {
            let chunks_by_digest = _.groupBy(chunks, chunk => chunk.digest_b64);
            return chunks_by_digest;
        });
}


function load_blocks_for_chunks(chunks) {
    if (!chunks || !chunks.length) return;
    return P.when(db.DataBlock.collection.find({
            chunk: {
                $in: mongo_utils.uniq_ids(chunks, '_id')
            },
            deleted: null,
        }).toArray())
        .then(blocks => nodes_store.populate_nodes_for_map(blocks, 'node'))
        .then(blocks => {
            let blocks_by_chunk = _.groupBy(blocks, 'chunk');
            _.each(chunks, chunk => chunk.blocks = blocks_by_chunk[chunk._id]);
        });
}

function load_jenia_magic_for_chunks(chunks) {
    let parts, objects;
    if (!chunks || !chunks.length) return;
    return P.when(db.ObjectPart.collection.find({
            chunk: {
                $in: mongo_utils.uniq_ids(chunks, '_id')
            },
            deleted: null,
        }).toArray())
        .then((res_parts) => {
            parts = res_parts;
            return db.ObjectMD.collection.find({
                _id: {
                    $in: mongo_utils.uniq_ids(res_parts, 'obj')
                },
                deleted: null,
            }).toArray();
        })
        .then((res_objects) => {
            objects = res_objects;
            return;
        })
        .then(() => {
            let result = [];
            _.forEach(chunks, chunk => {
                //console.warn('JEN CHUNK', chunk);
                var tmp_parts = _.filter(parts, part => String(part.chunk) === String(chunk._id));
                var tmp_objects = _.filter(objects, obj => _.find(tmp_parts, part => String(part.obj) === String(obj._id)));
                //console.warn('JEN PARTS', tmp_parts);
                //console.warn('JEN OBJECTS', tmp_objects);
                result[chunk._id] = {
                    parts: tmp_parts,
                    objects: tmp_objects
                };
            });
            return result;
        });
    /*.then(blocks => nodes_store.populate_nodes_for_map(blocks, 'node'))
    .then(blocks => {
        let blocks_by_chunk = _.groupBy(blocks, 'chunk');
        _.each(chunks, chunk => chunk.blocks = blocks_by_chunk[chunk._id]);
    });*/
}


function make_md_id(id_str) {
    return new mongodb.ObjectId(id_str);
}
