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
    "esri/tasks/RouteTask",
    "esri/tasks/support/RouteParameters",
    "esri/tasks/support/FeatureSet",
    "esri/Graphic",
    "esri/tasks/support/Query",
    "esri/geometry/Polyline",
    "esri/geometry/SpatialReference",
    "dojo/promise/all"
], function (FeatureLayer,
    RouteTask,
    RouteParameters,
    FeatureSet,
    Graphic,
    Query,
    Polyline,
    SpatialReference,
    all) {

    var __serviceLayersTemplate = {
        delivery: 0,
        customer: 1,
        driver: 2,
        route: 3,
        deliveryFence: 4
    };
    var __serviceLayers;
    var __serviceLayersCreated = false;

    return {
        getFeatureLayers: function (baseServices) {
            return __createLayers(baseServices);
        },
        loadFeatureLayers: function (baseService) {
            return __loadLayers(baseService);
        },
        buildRoute: function (baseService, driverId, customerIds) {
            __loadLayers(baseService);

            return __buildRoute(driverId, customerIds);
        },
        setSimLayers: function (baseSimService) {
            __setSimLayers(baseSimService);
        }
    }



    function __buildRoute(driverId, customerIds) {
        // Validate the inputs.
        if (driverId === undefined) {
            console.error("You must provide a DriverID");
            return;
        }
        if (customerIds.length == 0) {
            console.error("You must provide an array of customers");
            return;
        }

        var _driver, _customers, _stops, _customerStops, _routeID;

        var promise = new dojo.Deferred();

        // Given a Driver ID and an array of Customer IDs, get the actual features.
        getDriverAndCustomers(driverId, customerIds).then(function (results) {

            var drivers = results[0].features,
                customers = results[1].features;

            // Make sure the IDs actually gave us records to work with.
            if (drivers.length == 0 || customers.length == 0) {
                console.warn("Could not find driver or customers!")
                promise.reject("Could not find driver or customers");
                return;
            }

            _driver = drivers[0];
            _customers = customers;

            // Now get the optimal route from the driver to all the customers.
            return getRoute(_driver, customers);

        }).then(function (result) {

            // console.log("Optimized route generated!");
            var routeResult = result.routeResults[0];
            _stops = routeResult.stops;

            for (i = 0; i < _stops.length; i++) {
                var stop = _stops[i];
                // console.log(`Stop ${stop.attributes.Sequence}: ${stop.attributes.Name}`);
            }

            // Store the route geometry for display on a map. This will also
            // give us a unique Route ID that glues everything else together.
            return saveRoute(_driver, routeResult);

        }).then(function (addedRoute) {

            var range = 0.25;
            _routeID = addedRoute.globalId;
            _customerStops = _stops.slice(1);

            joinCustomersToStopsByID(_customerStops, _customers);

            // Store a delivery record for each customer along the route.
            //
            // Get geofences around each delivery so that we can trigger
            // a notification to each customer as the driver gets close.
            return all([calculateAndSaveZones(_routeID, _customerStops, range),
                saveDeliveries(_routeID, _customerStops)
            ]);

        }).then(function (results) {

            var savedZones = results[0];
            var savedDeliveries = results[1].successes;
            var unsavedDeliveries = results[1].failures;

            if (unsavedDeliveries.length > 0) {
                console.warn(`${unsavedDeliveries.length} deliveries could not be saved!`);
            }

            // console.log("Saved deliveries and zones");

            promise.resolve({
                routeID: _routeID,
                driver: _driver,
                customers: _customers,
                deliveries: savedDeliveries
            });

        }).otherwise(function (error) {

            console.error("Failed to save deliveries or zones");
            console.error(error);
            promise.reject(error);

        });

        return promise;
    }


    // ROUTES
    function getRoute(driver, customers) {
        var promise = new dojo.Deferred();

        var routeTask = new RouteTask({
            url: "https://route.arcgis.com/arcgis/rest/services/World/Route/NAServer/Route_World"
        });

        var stops = new FeatureSet({
            features: [driver].concat(customers).map(function (feature) {
                return getStopGraphic(feature);
            })
        });

        var params = new RouteParameters({
            findBestSequence: true,
            preserveFirstStop: true,
            preserveLastStop: false,
            returnStops: true,
            returnDirections: true,
            returnRoutes: true,
            stops: stops,
            outSpatialReference: SpatialReference.WebMercator
        });

        return routeTask.solve(params);
    }

    function singlePathGeometryFromPolyline(polyline, sr) {
        var totalPath = [];
        var count = 0;
        var singlePath = polyline.paths.reduce(function (a, b) {
            return a.concat(b)
        });
        count += singlePath.length;
        totalPath = totalPath.concat(singlePath);

        var result = new Polyline({
            paths: [totalPath],
            spatialReference: sr
        });

        return result;
    }

    function singlePathPolylineFromRouteDirections(routeResult) {
        var totalPath = [];
        var count = 0;
        for (i = 0; i < routeResult.directions.features.length; i++) {
            var directionGeom = routeResult.directions.features[i].geometry;
            console.log(`Adding ${directionGeom.paths.length} paths from geometry ${i}`);
            var singlePath = directionGeom.paths.reduce(function (a, b) {
                return a.concat(b)
            });
            count += singlePath.length;
            console.log(`Reduced to ${singlePath.length} points`);
            totalPath = totalPath.concat(singlePath);
        }

        var result = new Polyline({
            paths: [totalPath],
            spatialReference: routeResult.directions.mergedGeometry.spatialReference
        });

        return result;
    }

    function saveRoute(driver, routeResult) {
        var promise = new dojo.Deferred();

        var routeLayer = __serviceLayers.route;
        var routeGraphic = routeResult.route;

        let stopCount = routeGraphic.attributes.StopCount - 1,
            duration = Math.ceil(routeGraphic.attributes.Total_TravelTime),
            distance = routeGraphic.attributes.Total_Miles;

        distance = Math.round(distance * 100) / 100;

        var description = `Delivery route with ${stopCount} stop${stopCount>1?'s':''} (${distance} miles, ${duration} mins)`;

        routeGraphic.attributes = {
            DriverID: driver.attributes.GlobalID,
            Description: description
        };

        // routeGraphic.geometry = singlePathPolylineFromRouteDirections(routeResult);

        routeLayer.applyEdits({
            addFeatures: [
                routeGraphic
            ]
        }).then(function (routeSaveResult) {
            var addedRoute = routeSaveResult.addFeatureResults[0];

            if (addedRoute.error !== null) {
                console.error("Error saving route!");
                console.error(addedRoute.error.message);
                promise.reject(addedRoute.error);
                return;
            }

            var routeId = addedRoute.globalId;

            saveSimRoute(routeId, routeGraphic, routeResult);

            promise.resolve(addedRoute);
        }).otherwise(function (error) {
            console.error("Error saving route!");
            promise.reject(error);
        });

        return promise;
    }

    function saveSimRoute(routeId, routeGraphic, routeResult) {
        if (__serviceLayers.routeSimLayer === undefined) {
            console.warn("No Sim Layer defined.");
            return
        }

        var directions = routeResult.directions.features;
        var routeGraphics = [];
        var previousDirectionGraphic;
        for (var i = 0; i < directions.length; i++) {
            var directionManeuver = directions[i],
                maneuverType = directionManeuver.attributes.maneuverType;

            if (maneuverType == 'esriDMTDepart') {
                continue;
            }

            if (maneuverType == 'esriDMTStop' && previousDirectionGraphic !== undefined) {
                previousDirectionGraphic.attributes.PauseAfter = true;
                continue;
            }

            var directionGraphic = routeGraphic.clone();
            directionGraphic.geometry = singlePathGeometryFromPolyline(directionManeuver.geometry, routeGraphic.geometry.spatialReference);
            directionGraphic.attributes.RouteID = routeId;
            directionGraphic.attributes.NextStop = 0;
            directionGraphic.attributes.Sequence = i;
            directionGraphic.attributes.Type = maneuverType;
            directionGraphic.attributes.PauseAfter = false;
            routeGraphics.push(directionGraphic);

            previousDirectionGraphic = directionGraphic;
        }

        __serviceLayers.routeSimLayer.applyEdits({
            addFeatures: routeGraphics
        }).then(function (routeSimSaveResult) {
            for (i = 0; i < routeSimSaveResult.addFeatureResults.length; i++) {
                var addedResult = routeSimSaveResult.addFeatureResults[i];

                if (addedResult.error !== null) {
                    console.warn(`Error saving simulation part ${addedResult.error.message}`);
                }
            }
        }).otherwise(function (error) {
            console.error("Error saving route simulation!");
        });
    }



    // ZONES
    function calculateAndSaveZones(routeID, customerStops, range) {
        var promise = new dojo.Deferred();

        calculateZones(routeID, customerStops, range).then(function (results) {
            // console.log("Got some zones!");

            // We save those for display and realtime reference as the driver progresses.
            saveZones(results).then(function (result) {
                // console.log("Saved zones!");
                // console.log(result.addFeatureResults);
                promise.resolve(result.addFeatureResults);
            }).otherwise(function (error) {
                console.error("Error saving zones!");
                console.error(error);
                promise.reject(error);
            })

        }).otherwise(function (error) {
            console.error("Error getting zones!");
            console.error(error);
            promise.reject(error);
        });

        return promise;
    }

    function calculateZones(routeID, deliveries, range) {
        var promise = new dojo.Deferred();

        calculateZoneGeometriesByDriveTime(deliveries, 4)
            // calculateZoneGeometriesByBuffer(deliveries, range)
            .then(function (results) {
                var zoneGraphics = results.map(function (deliveryZoneGeom, index) {
                    var delivery = deliveries[index],
                        sequence = delivery.attributes.Sequence - 1;
                    var description = `${range} range around customer ${delivery.attributes.Name}. Delivery ${sequence} on route ${routeID}.`
                    return new Graphic({
                        geometry: deliveryZoneGeom,
                        attributes: {
                            CustomerID: delivery.attributes.Name,
                            Range: range,
                            RouteID: routeID,
                            Sequence: sequence,
                            Description: description
                        }
                    })
                });

                promise.resolve(zoneGraphics);
            })
            .otherwise(function (error) {
                promise.reject(error);
            });

        return promise;
    }

    function saveZones(zones) {
        var promise = new dojo.Deferred();

        var zoneLayer = __serviceLayers.deliveryFence;
        zoneLayer.applyEdits({
            addFeatures: zones
        }).then(function (results) {
            promise.resolve(results);
        }).otherwise(function (error) {
            console.error("Error saving delivery zones!");
            promise.reject(error);
        })

        return promise;
    }



    // ZONE GENERATION
    function calculateZoneGeometriesByBuffer(deliveries, range) {
        var promise = new dojo.Deferred();

        require(["esri/geometry/geometryEngineAsync"], function (geometryEngineAsync) {

            var deliveryGeoms = deliveries.map(function (delivery) {
                return delivery.geometry
            });
            geometryEngineAsync.geodesicBuffer(deliveryGeoms, range, "miles").then(function (buffers) {
                promise.resolve(buffers);
            }).otherwise(function (error) {
                console.error("Error calculating zone buffers!");
                promise.reject(error);
            });
        });

        return promise;
    }

    function calculateZoneGeometriesByDriveTime(deliveries, range) {
        var promise = new dojo.Deferred();

        require(["esri/tasks/ServiceAreaTask",
                "esri/tasks/support/ServiceAreaParameters",
                "esri/tasks/support/FeatureSet",
                "esri/tasks/support/ServiceAreaSolveResult"
            ],
            function (ServiceAreaTask, ServiceAreaParameters, FeatureSet, ServiceAreaSolveResult) {

                fix44ServiceAreaSolveResult(ServiceAreaSolveResult);

                var serviceAreaTask = new ServiceAreaTask({
                    url: "https://route.arcgis.com/arcgis/rest/services/World/ServiceAreas/NAServer/ServiceArea_World"
                });

                var facilities = new FeatureSet({
                    features: deliveries.map(function (delivery) {
                        return getStopGraphic(delivery);
                    })
                });

                // impedanceAttribute: "TravelTime",
                var params = new ServiceAreaParameters({
                    travelDirection: "to-facility",
                    defaultBreaks: [range],
                    outSpatialReference: SpatialReference.WebMercator,
                    facilities: facilities,
                    returnFacilities: true,
                    trimOuterPolygon: true,
                    trimPolygonDistance: 10,
                    trimPolygonDistanceUnits: 'meters',
                    overlapPolygons: true
                });

                serviceAreaTask.solve(params)
                    .then(function (driveTimeGraphics) {

                        buffers = driveTimeGraphics.serviceAreaPolygons.sort(function (g1, g2) {
                            return g1.attributes.FacilityID > g2.attributes.FacilityID
                        }).map(function (g) {
                            return g.geometry
                        });

                        promise.resolve(buffers);
                    }).otherwise(function (error) {
                        console.error("Error calculating zone service areas!");
                        promise.reject(error);
                    });
            });

        return promise;
    }

    function fix44ServiceAreaSolveResult(ServiceAreaSolveResult) {
        ServiceAreaSolveResult.prototype._graphicsFromJson = function (json) {
            if (!json) {
                return null;
            }
            var sr = SpatialReference.fromJSON(json.spatialReference),
                features = json.features;

            if (Array.isArray(features)) {
                features = features.map(function (feature) {
                    var graphic = Graphic.fromJSON(feature);
                    graphic.geometry.spatialReference = sr;
                    return graphic;
                });
            }

            return features;
        };
    }


    // READING RECORDS
    function getDriverAndCustomers(driverId, customerIds) {
        var driverLayer = __serviceLayers.driver;
        var driverQuery = new Query({
            outFields: ["GlobalID", "Name"],
            where: `GlobalID='${driverId}'`,
            returnGeometry: true
        });

        var customerLayer = __serviceLayers.customer;
        var customerQuery = new Query({
            outFields: ["GlobalID", "Name", "SingleLineAddress"],
            where: `GlobalID IN (${customerIds.map(function(val) { return `'${val}'`; }).join()})`,
            returnGeometry: true
        });

        return all([
            driverLayer.queryFeatures(driverQuery),
            customerLayer.queryFeatures(customerQuery)
        ]);
    }



    function joinCustomersToStopsByID(stops, customers) {
        if (stops.length != customers.length) {
            console.warn("joining different numbers of stops and customers!!");
        }

        var customerDict = {};
        for (i = 0; i < customers.length; i++) {
            var customer = customers[i];
            customerDict[customer.attributes.GlobalID] = customer;
        }

        for (i = 0; i < stops.length; i++) {
            var stop = stops[i],
                customerId = stop.attributes.Name,
                customer = customerDict[customerId];

            stop.customerFeature = customer;

            stop.attributes.Cumul_TravelTimeEst = Math.ceil(stop.attributes.Cumul_TravelTime);
            stop.attributes.Description = getStopDescription(stop);

            if (customer == undefined) {
                console.warn(`Could not find customer ${customerId} to attach to ordered stop.`);
            }
        }
    }

    function getStopDescription(stop) {
        var customerName = stop.customerFeature.attributes.Name,
            customerAddress = stop.customerFeature.attributes.SingleLineAddress;

        if (customerAddress === null) {
            customerAddress = '';
        }

        if (customerAddress !== '') {
            customerAddress = ` at ${customerAddress}`;
        }

        var attrs = stop.attributes;

        return `Delivery ${attrs.Sequence-1} due in about ${attrs.Cumul_TravelTimeEst || attrs.Cumul_TravelTime} minutes: ${customerName}${customerAddress}`;
    }




    // DELIVERIES
    function saveDeliveries(routeID, customerStops) {
        var promise = new dojo.Deferred();

        var deliveries = customerStops.map(function (stop, index) {
            return new Graphic({
                geometry: stop.geometry,
                attributes: {
                    RouteID: routeID,
                    Sequence: stop.attributes.Sequence - 1,
                    CustomerID: stop.attributes.Name,
                    ETA: stop.attributes.Cumul_TravelTimeEst || stop.attributes.Cumul_TravelTime,
                    Description: stop.attributes.Description
                }
            });
        });

        var deliveryLayer = __serviceLayers.delivery;

        deliveryLayer.applyEdits({
            addFeatures: deliveries
        }).then(function (results) {
            var additions = results.addFeatureResults;
            var successes = [];
            var failures = [];

            for (i = 0; i < additions.length; i++) {
                var addition = additions[i];
                var delivery = deliveries[i];

                if (addition.error !== null) {
                    delivery.attributes.saveError = error
                    failures.push(delivery);
                    console.warn(`Could not write delivery ${i}: ${addition.error.message}`);
                } else {
                    delivery.attributes.GlobalId = addition.globalId;
                    successes.push(delivery);
                }
            }

            if (successes.length == 0) {
                console.error("Error saving deliveries!");
                promise.reject(new Error("Could not write any deliveries"));
            } else {
                promise.resolve({
                    successes: successes,
                    failures: failures
                });
            }

        }).otherwise(function (error) {
            console.error("Error saving deliveries!");
            promise.reject(error);
        });

        return promise;
    }



    // HELPERS AND MISCELLANEOUS
    function getStopGraphic(feature) {
        return new Graphic({
            geometry: feature.geometry,
            attributes: {
                Name: feature.attributes.GlobalID || feature.attributes.Name
            }
        });
    }


    function __setSimLayers(baseSimService) {
        __serviceLayers.routeSimLayer = new FeatureLayer({
            url: `${baseSimService}/2`
        });
    }


    function __createLayers(baseService) {
        if (__serviceLayersCreated) {
            return __serviceLayers;
        }

        var layerKeys = Object.keys(__serviceLayersTemplate);
        __serviceLayers = {};

        for (i = 0; i < layerKeys.length; i++) {
            var layerKey = layerKeys[i],
                layerIndex = __serviceLayersTemplate[layerKey];
            var layer = new FeatureLayer({
                url: `${baseService}/${layerIndex}`,
                outFields: ["*"]
            });
            __serviceLayers[layerKey] = layer;
        }

        __serviceLayersCreated = true;

        return __serviceLayers;
    }

    function __loadLayers(baseService) {
        var promise = new dojo.Deferred();

        __createLayers(baseService);

        var layerKeys = Object.keys(__serviceLayers);
        var layersToLoad = layerKeys.length;

        for (i = 0; i < layerKeys.length; i++) {
            var layerKey = layerKeys[i],
                layer = __serviceLayers[layerKey];
            layerLoadHandlerForLayer(layer, promise);
        }

        return promise;

        function layerLoadHandlerForLayer(layer, p) {
            layer.load().then(function () {
                layersToLoad--;
                if (layersToLoad == 0) {
                    console.log(`All layers loaded!`);
                    p.resolve(__serviceLayers);
                } else {
                    // console.log(`Still waiting for ${layersToLoad} layers to load…`);
                }
            });
        }
    }
});