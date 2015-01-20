/* global angular */
'use strict';

var _ = require('lodash');
var moment = require('moment');
var size_utils = require('../util/size_utils');
var api = require('../api');

var nb_api = angular.module('nb_api');

nb_api.factory('nbNodes', [
    '$q', '$timeout', 'nbGoogle', '$window', '$rootScope',
    '$location', 'nbAlertify', 'nbModal', 'nbClient', 'nbSystem',
    function($q, $timeout, nbGoogle, $window, $rootScope,
        $location, nbAlertify, nbModal, nbClient, nbSystem) {
        var $scope = {};
        $scope.refresh_node_groups = refresh_node_groups;
        $scope.draw_nodes_map = draw_nodes_map;
        $scope.list_nodes = list_nodes;
        $scope.read_node = read_node;
        $scope.lookup_node = lookup_node;
        $scope.goto_node_by_block = goto_node_by_block;
        $scope.add_nodes = add_nodes;
        $scope.remove_node = remove_node;
        $scope.start_node = start_node;
        $scope.stop_node = stop_node;


        function refresh_node_groups(selected_geo) {
            return $q.when().then(
                function() {
                    return nbClient.client.node.group_nodes({
                        group_by: {
                            geolocation: true
                        }
                    });
                }
            ).then(
                function(res) {
                    console.log('NODE GROUPS', res);
                    $scope.node_groups = res.groups;
                    $scope.node_groups_by_geo = _.indexBy(res.groups, 'geolocation');
                    $scope.nodes_count = _.reduce(res.groups, function(sum, g) {
                        return sum + g.count;
                    }, 0);
                    if (res.groups.length) {
                        $scope.has_nodes = true;
                        $scope.has_no_nodes = false;
                    } else {
                        $scope.has_nodes = false;
                        $scope.has_no_nodes = true;
                    }
                    return draw_nodes_map(selected_geo);
                }
            );
        }

        function list_nodes(params) {
            return $q.when().then(
                function() {
                    return nbClient.client.node.list_nodes(params);
                }
            ).then(
                function(res) {
                    console.log('NODES', res);
                    var nodes = res.nodes;
                    _.each(nodes, extend_node_info);
                    return nodes;
                }
            );
        }

        function read_node(name) {
            return $q.when().then(
                function() {
                    return nbClient.client.node.read_node({
                        name: name
                    });
                }
            ).then(
                function(res) {
                    console.log('READ NODE', res);
                    var node = res;
                    extend_node_info(node);
                    return node;
                }
            );
        }

        function lookup_node(params) {
            return $q.when().then(
                function() {
                    return nbClient.client.node.lookup_node(params);
                }
            ).then(
                function(res) {
                    console.log('LOOKUP NODE', res);
                    var node = res;
                    extend_node_info(node);
                    return node;
                }
            );
        }

        function goto_node_by_block(block) {
            return lookup_node({
                ip: block.node.ip,
                port: block.node.port
            })
            .then(function(node) {
                $location.path('/tier/' + node.tier + '/' + node.name);
            });
        }

        function extend_node_info(node) {
            node.hearbeat_moment = moment(new Date(node.heartbeat));
            node.usage_percent = 100 * node.storage.used / node.storage.alloc;
            // TODO resolve vendor id to name by client or server?
            // node.vendor = $scope.node_vendors_by_id[node.vendor];
        }

        function add_nodes() {
            var edge_tiers = _.filter(nbSystem.system.tiers, {
                kind: 'edge'
            });
            if (!edge_tiers || !edge_tiers.length) {
                nbAlertify.alert(
                    'In order to add nodes you will need to ' +
                    'setup node-vendors for your account. ' +
                    'Please seek professional help.');
                return;
            }

            // make a scope for the modal
            var scope = $rootScope.$new();
            scope.count = 1;
            scope.edge_tiers = edge_tiers;
            scope.selected_tier = edge_tiers[0];
            scope.allocate_gb = 1;

            // in order to allow input[type=range] and input[type=number]
            // to work together, we need to convert the value from string to number
            // because type=range uses strings and type=number does not accept strings.
            Object.defineProperty(scope, 'allocate_gb_str', {
                enumerable: true,
                get: function() {
                    return scope.allocate_gb;
                },
                set: function(val) {
                    scope.allocate_gb = parseInt(val);
                }
            });

            scope.add_nodes = function() {
                console.log('ADD NODES');
                if (typeof(scope.count) !== 'number' ||
                    scope.count < 1 || scope.count > 100) {
                    throw 'Number of nodes should be a number in range 1-100';
                }
                if (typeof(scope.allocate_gb) !== 'number' ||
                    scope.allocate_gb < 1 || scope.allocate_gb > 100) {
                    throw 'Gigabyte per node should be a number in range 1-100';
                }
                if (!scope.selected_tier.id) {
                    throw 'Missing selection where to run on';
                }
                var next_node_name = $scope.nodes_count + 1;
                var num_created = 0;
                // using manual defer in order to report progress to the ladda button
                var defer = $q.defer();
                $q.all(_.times(scope.count, function(i) {
                    return $q.when(nbClient.client.node.create_node({
                        name: '' + (next_node_name + i),
                        // TODO these sample geolocations are just for testing
                        geolocation: _.sample([
                            'United States', 'Canada', 'Brazil', 'Mexico',
                            'China', 'Japan', 'Korea', 'India', 'Australia',
                            'Israel', 'Romania', 'Russia',
                            'Germany', 'England', 'France', 'Spain',
                        ]),
                        storage_alloc: scope.allocate_gb * size_utils.GIGABYTE,
                        tier: scope.selected_tier.name,
                    })).then(function() {
                        num_created += 1;
                        defer.notify(num_created / scope.count);
                    });
                })).then(refresh_node_groups).then(defer.resolve, defer.reject);
                return defer.promise;
            };

            var defer = $q.defer();

            scope.run = function() {
                return $q.when(true,
                    function() {
                        return scope.add_nodes();
                    }
                ).then(
                    function() {
                        nbAlertify.success('The deed is done');
                        scope.modal.modal('hide');
                        defer.resolve();
                    },
                    function(err) {
                        nbAlertify.error(err.data || err.message || err.toString());
                        defer.reject(err);
                    }
                );
            };

            scope.modal = nbModal({
                template: 'add_nodes_dialog.html',
                scope: scope,
            });

            // this promise is a bit fishy, we only resolve/reject it if the
            // modal is run (which can even be multiple times) and we don't
            // do anything if the modal is just closed.
            // this is fine as long as we only need it as a notification for refreshing
            // after the nodes were added.
            return defer.promise;
        }


        function remove_node(node) {
            return nbAlertify.confirm('Really remove node ' +
                node.name + ' @ ' + node.geolocation + ' ?').then(
                function() {
                    return $q.when(nbClient.client.node.delete_node({
                        name: node.name
                    })).then(refresh_node_groups);
                }
            );
        }


        function start_node(node) {
            return $q.when(nbClient.client.node.start_nodes({
                nodes: [node.name]
            }));
        }

        function stop_node(node) {
            return $q.when(nbClient.client.node.stop_nodes({
                nodes: [node.name]
            }));
        }


        function draw_nodes_map(selected_geo, google) {
            if (!google) {
                return nbGoogle.then(function(google) {
                    return draw_nodes_map(selected_geo, google);
                });
            }
            var element = $window.document.getElementById('nodes_map');
            if (!element) {
                return;
            }
            var min_alloc = Infinity;
            var max_alloc = -Infinity;
            var min_num_nodes = Infinity;
            var max_num_nodes = -Infinity;
            var data = new google.visualization.DataTable();
            data.addColumn('string', 'Location');
            data.addColumn('number', 'Capacity');
            data.addColumn('number', 'Nodes');
            var selected_row = -1;
            _.each($scope.node_groups, function(stat, index) {
                if (stat.geolocation === selected_geo) {
                    selected_row = index;
                }
                if (stat.storage.alloc > max_alloc) {
                    max_alloc = stat.storage.alloc;
                }
                if (stat.storage.alloc < min_alloc) {
                    min_alloc = stat.storage.alloc;
                }
                if (stat.count > max_num_nodes) {
                    max_num_nodes = stat.count;
                }
                if (stat.count < min_num_nodes) {
                    min_num_nodes = stat.count;
                }
                data.addRow([stat.geolocation, {
                    v: stat.storage.alloc,
                    f: $rootScope.human_size(stat.storage.alloc)
                }, stat.count]);
                console.log(stat, min_alloc, max_alloc);
            });
            var options = {
                displayMode: 'markers',
                enableRegionInteractivity: true,
                keepAspectRatio: true,
                backgroundColor: 'transparent',
                datalessRegionColor: '#cfd8dc', // blue-grey-100
                // datalessRegionColor: '#b2dfdb', // teal-100
                // datalessRegionColor: '#10312D', // ~teal
                colorAxis: {
                    // colors: ['#fff176', '#ffee58'], // yellow 300-400
                    // colors: ['#909688', '#009688'], // teal
                    // colors: ['#F9FFF4', '#76FF00'], // greens
                    // colors: ['#EC407A', '#E91E63'], // pink 400-500
                    colors: ['#7e57c2', '#673ab7'], // deep-purple 400-500
                    // colors: ['#00bcd4', '#00acc1'], // cyan 400-500
                    minValue: min_alloc,
                    maxValue: max_alloc,
                },
                sizeAxis: {
                    minSize: 10,
                    maxSize: 12,
                    minValue: min_num_nodes,
                    maxValue: max_num_nodes,
                },
                legend: 'none' || {
                    textStyle: {
                        color: 'black',
                        fontSize: 16
                    }
                },
                magnifyingGlass: {
                    enable: false,
                    zoomFactor: 10
                },
                tooltip: {
                    trigger: 'both' // 'focus' / 'selection'
                },
            };
            var chart = new google.visualization.GeoChart(element);
            google.visualization.events.addListener(chart, 'ready', function() {
                if (selected_row >= 0) {
                    chart.setSelection([{
                        row: selected_row,
                        column: null,
                    }]);
                }
            });
            google.visualization.events.addListener(chart, 'select', function() {
                var selection = chart.getSelection();
                if (selection[0]) {
                    var geo = data.getValue(selection[0].row, 0);
                    $location.path('nodes/geo/' + geo);
                } else {
                    $location.path('nodes');
                }
                $rootScope.safe_apply();
            });
            chart.draw(data, options);
        }

        return $scope;
    }
]);
