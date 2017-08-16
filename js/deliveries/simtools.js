// Copyright 2017 Esri
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//     http://www.apache.org/licenses/LICENSE-2.0
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.​

define([
    "esri/layers/FeatureLayer",
    "esri/geometry/geometryEngine",
    "esri/geometry/Point",
    "esri/tasks/RouteTask",
    "esri/tasks/support/RouteParameters",
    "esri/tasks/support/FeatureSet",
    "esri/Graphic",
    "esri/tasks/support/Query",
    "esri/geometry/SpatialReference",
    "dojo/promise/all"
], function (FeatureLayer,
    geometryEngine,
    Point,
    RouteTask,
    RouteParameters,
    FeatureSet,
    Graphic,
    Query,
    SpatialReference,
    all) {

    var __simLayersTemplate = {
        driver: 0,
        routeCruises: 1,
        route: 2
    };
    var __simLayers;
    var __simLayersCreated = false;

    var __simStatus = {
        starting: 'starting',
        running: 'running',
        paused: 'paused',
        ended: 'ended'
    };

    var __cruiseRouteId = "JUSTCRUISING";

    var __currentSims = {
        // driverId: { 
        //   routes: {
        //     routeId: routeFeature 
        //   },
        //   id: driverId,
        //   routeId: routeId,
        //   sequence: sequence,
        //   locationUpdateCallback: function(newPoint) {},
        //   status: 'starting' | 'running' | 'paused' | 'ended'
        //   repeat: false (true if the fallback Cruise)
        // }
    };

    return {
        getFeatureLayers: function (baseServices) {
            return __createLayers(baseServices);
        },
        loadFeatureLayers: function (baseService) {
            return __loadLayers(baseService);
        },
        simulateCruise: function (driverId, locationUpdateCallback, intervalMs) {
            return __simulateDrive(driverId, undefined, locationUpdateCallback, intervalMs);
        },
        simulateDrive: function (driverId, routeId, locationUpdateCallback, intervalMs, pauseDuration) {
            return __simulateDrive(driverId, routeId, locationUpdateCallback, intervalMs, pauseDuration);
        },
        cruiseRouteId: __cruiseRouteId
    }

    function __simulateDrive(driverId, routeId, locationUpdateCallback, interval, pauseDuration) {
        var promise = new dojo.Deferred();

        if (routeId === undefined || routeId === null || routeId === '' || routeId == __cruiseRouteId) {
            routeId = __cruiseRouteId;
        }

        loadRouteForDriver(driverId, routeId).then(function (route) {
            var driverSim = __currentSims[driverId];
            driverSim.id = driverId;
            driverSim.routeId = routeId;
            driverSim.repeat = (routeId == __cruiseRouteId);
            driverSim.currentSubRoute = 0;
            driverSim.sequence = 1;
            driverSim.locationUpdateCallback = locationUpdateCallback
            driverSim.currentLocation = null;
            driverSim.speed = 1;
            if (pauseDuration !== undefined) {
                driverSim.pauseDuration = pauseDuration * 1000;
            }

            driverSim.status = __simStatus.starting;
            driverSim.pause = function () {
                pauseCurrentSimulation(driverId);
            }
            driverSim.resume = function () {
                startOrResumeCurrentSimulation(driverId);
            }
            driverSim.abort = function () {
                abortCurrentSimulation(driverId);
            }

            // Internal stuff
            driverSim.__intPtSeq = 0
            startOrResumeCurrentSimulation(driverId, interval);

            promise.resolve(driverSim);
        }).otherwise(function (error) {
            console.error("Error getting simulation route");
            promise.reject(error);
        });

        return promise;
    }

    function startOrResumeCurrentSimulation(driverId, interval) {
        var driverSim = __currentSims[driverId];
        if (driverSim === undefined) {
            return;
        }

        if (driverSim.status == __simStatus.running || driverSim.status == __simStatus.ended) {
            return;
        }

        driverSim.__intTimerInterval = driverSim.__intTimerInterval || interval || 1000;
        driverSim.__intTimer = window.setInterval(function () {

            var wasAtStop = driverSim.atStop !== undefined,
                nextLocation = getNextLocation(driverId),
                isAtStop = driverSim.atStop !== undefined,
                arrivedAtStop = isAtStop && !wasAtStop,
                departedStop = wasAtStop && !isAtStop;

            if (nextLocation === undefined) {
                driverSim.status = __simStatus.ended;
                // console.log(`Ran out of points at sequence ${driverSim.__intPtSeq}!`);
                window.clearInterval(driverSim.__intTimer);
            } else {
                // console.log(`Location ${driverSim.__intPtSeq} is ${nextLocation.latitude}, ${nextLocation.longitude}`);
            }

            driverSim.currentLocation = nextLocation;
            driverSim.locationUpdateCallback(nextLocation, driverSim, arrivedAtStop);

        }, driverSim.__intTimerInterval);

        driverSim.status = __simStatus.running;
    }

    function pauseCurrentSimulation(driverId) {
        var driverSim = __currentSims[driverId];
        if (driverSim === undefined) {
            return;
        }

        if (driverSim.status != __simStatus.running) {
            return;
        }

        window.clearInterval(driverSim.__intTimer);
        delete driverSim.__intTimer;

        driverSim.status = __simStatus.paused;
    }

    function abortCurrentSimulation(driverId) {
        var driverSim = __currentSims[driverId];
        if (driverSim === undefined) {
            return;
        }

        if (driverSim.status != __simStatus.running) {
            return;
        }

        window.clearInterval(driverSim.__intTimer);
        delete driverSim.__intTimer;

        driverSim.status = __simStatus.ended;
    }

    function getNextLocation(driverId) {
        var driverSim = __currentSims[driverId];
        if (driverSim === undefined || driverSim.subRoutes.length == 0) {
            return;
        }

        var driverRoute = driverSim.subRoutes[driverSim.currentSubRoute];
        if (driverSim.__intPtSeq >= driverRoute.geometry.paths[0].length) {

            // No more points left on this part of the route. Is there a next part?
            // console.log(`Finished all points on subRoute ${driverSim.currentSubRoute} [${driverSim.__intPtSeq}]`);
            if (driverSim.pauseDuration !== undefined) {

                var repeatedLastPoint = driverRoute.geometry.getPoint(0, driverRoute.geometry.paths[0].length - 1);

                if (driverSim.pauseBeganAt === undefined) {

                    // We need to begin a pause at this stop.
                    // console.log("Starting a pause");
                    driverSim.pauseBeganAt = performance.now();
                    driverSim.atStop = true;
                    return repeatedLastPoint;

                } else {

                    if ((performance.now() - driverSim.pauseBeganAt) >= driverSim.pauseDuration) {
                        // We've been paused long enough.
                        // console.log("Ending a pause");
                        delete driverSim.pauseBeganAt;
                        delete driverSim.atStop;
                    } else {
                        // console.log("Continuing a pause", (performance.now() - driverSim.pauseBeganAt)/1000);
                        return repeatedLastPoint;
                    }

                }
            }

            if (driverSim.currentSubRoute >= driverSim.subRoutes.length - 1) {
                // No next part. We either repeat or stop.
                // console.log(`Finished all points on all subRoute ${driverSim.currentSubRoute}`);
                if (driverSim.repeat) {
                    driverSim.currentSubRoute = 0;
                    driverSim.__intPtSeq = 0;
                    driverRoute = driverSim.subRoutes[driverSim.currentSubRoute];
                } else {
                    return;
                }
            } else {
                // Move on to the next part
                driverSim.currentSubRoute += 1;
                driverSim.__intPtSeq = 0;
                driverRoute = driverSim.subRoutes[driverSim.currentSubRoute];
            }
        }

        driverSim.sequence = driverSim.currentSubRoute + 1;

        var nextPt = driverRoute.geometry.getPoint(0, driverSim.__intPtSeq);
        driverSim.__intPtSeq += Math.round(driverSim.speed);

        return nextPt;
    }

    function loadRouteForDriver(driverId, routeId) {
        var promise = new dojo.Deferred();

        // Let's look in the simulation layer for the route.
        var query = new Query({
            where: `DriverID='${driverId}'`,
            outFields: ['*'],
            orderByFields: ['Sequence ASC'],
            returnGeometry: true
        });

        if (routeId === undefined || routeId === null || routeId === '' || routeId == __cruiseRouteId) {
            // If no routeId, then just get the cruising route
            routeId = __cruiseRouteId;
            query.where = `(${query.where}) AND RouteID IS NULL`
        } else {
            query.where = `(${query.where}) AND RouteID='${routeId}'`
        }

        var routeSimLayer = routeId == __cruiseRouteId ? __simLayers.routeCruises : __simLayers.route;

        routeSimLayer.queryFeatures(query).then(function (results) {
            if (results.features.length == 0) {
                console.warn(`Route ${routeId} not found for driver ${driverId}`);
                var err = new Error(`Route ${routeId} not found for driver ${driverId}`);
                return promise.reject(err);
            }

            var route = results.features[0];

            var pathToStop = [],
                subRoutes = [];
            results.features.forEach(function(feature, index) {
                var featurePaths = feature.geometry.paths.reduce(function (a, b) {
                    return a.concat(b)
                });
                pathToStop = pathToStop.concat(featurePaths);
                if (feature.attributes.PauseAfter == 1 || index == results.features.length - 1) {
                    var subRoute = route.clone();
                    subRoute.geometry.paths = [pathToStop];
                    pathToStop = [];
                    subRoutes.push(subRoute);
                }
            });

            var sim = getSim(driverId, routeId, subRoutes);

            promise.resolve(sim);
        });

        return promise;
    }

    function getSim(driverId, routeId, subRoutes) {
        __currentSims[driverId] = __currentSims[driverId] || defaultSim();

        subRoutes.forEach(function(subRoute) {
            // Average speed in Manhattan is 10mph, or ~4.5m/s, so we'll use 5m/s
            subRoute.geometry = geometryEngine.densify(subRoute.geometry, 5, 'meters');
            // We now have a single-path geometry where each vertex is 5m away from the next (may be closer at original
            // route vertices, but that's OK).
            if (subRoute.geometry.paths.length > 1) {
                // Reduce all the paths into one continuous path.
                console.log(`Reducing ${subRoute.geometry.paths.length} polyline paths…`);
                subRoute.geometry.paths = [subRoute.geometry.paths.reduce(function (a, b) {
                    return a.concat(b);
                })];
            }
        });

        var driverSim = __currentSims[driverId];
        driverSim.routeId = routeId;
        driverSim.subRoutes = subRoutes;

        return driverSim;
    }

    function defaultSim() {
        return {
            routeId: null,
            subRoutes: [],
            currentSubRoute: 0,
            sequence: 0,
            paused: false
        };
    }









    function __createLayers(baseService) {
        if (__simLayersCreated) {
            return __simLayers;
        }

        var layerKeys = Object.keys(__simLayersTemplate);
        __simLayers = {};

        layerKeys.forEach(function(layerKey) {
            var layerIndex = __simLayersTemplate[layerKey];
            var layer = FeatureLayer({
                url: `${baseService}/${layerIndex}`
            });
            __simLayers[layerKey] = layer;
        });

        __simLayersCreated = true;

        return __simLayers;
    }

    function __loadLayers(baseService) {
        var promise = new dojo.Deferred();

        __createLayers(baseService);

        var layerKeys = Object.keys(__simLayers);
        var layersToLoad = layerKeys.length;

        layerKeys.forEach(function(layerKey) {
            var layer = __simLayers[layerKey];
            layerLoadHandlerForLayer(layer, promise);
        });

        return promise;

        function layerLoadHandlerForLayer(layer, p) {
            layer.load().then(function () {
                layersToLoad--;
                if (layersToLoad == 0) {
                    console.log(`All layers loaded!`);
                    p.resolve(__simLayers);
                } else {
                    console.log(`Still waiting for ${layersToLoad} layers to load…`);
                }
            });
        }
    }
});