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

export default (request) => {
    // Authentication - see https://developers.arcgis.com/applications/new
    const clientID = 'YOUR CLIENTID';
    const clientSecret = 'YOUR CLIENT SECRET';

    // Configure these ArcGIS Feature Service end points. These are the User Point and GeoFence Polygon layers.
    const baseURL = 'YOUR DELIVERYTRACKING URL';
    const usersURL = `${baseURL}/2`;
    const geofencesURL = `${baseURL}/4`;

    const query = require('codec/query_string');

    // return if the block does not have anything to analyze
    if (!query) {
        return request.ok();
    }

    const console = require('console');
    
    // Parse out the required parameters
    let userId = request.message.driverId;
    let newLat = request.message.lat;
    let newLng = request.message.lng;

    if (userId === undefined || newLat === undefined || newLng === undefined) {
        console.log('You must provide "user", "lat" and "lng" parameters!');
        return request.abort('You must provide "user", "lat" and "lng" parameters!');
        // Sample parameters to trigger notification when approaching next order.
        // Sequence represents the next order index along the route (routeId).
        // {
        //     "driverId": "D9A40B40-FD98-4CD0-8DFB-87C4C1D48C19",
        // 	   "lat": 40.756,
        //     "lng": -73.963,
        // 	   "routeId": "8B460A98-5B83-4797-9929-3DB51EBFE32F",
        // 	   "sequence": 0
        // }
        //
        // or (if no route currently active, just to update driver location)
        //
        // {
        //     "driverId": "D9A40B40-FD98-4CD0-8DFB-87C4C1D48C19",
        //     "lat": 40.756,
        //     "lng": -73.963
        // }
    }

    // Require console to print debug information
    const pubnub = require("pubnub");
    const xhr = require('xhr');
    const promise = require('promise');

    // Optional Parameters
    let routeId = request.message.routeId;
    let sequence = request.message.sequence;

    pubnubPublishDriverLocation(userId, newLat, newLng, routeId, sequence);

    return getToken(clientID, clientSecret).then(() => {
        const arcgisToken = request.message.arcgisToken;
        delete request.message.arcgisToken;
        // Get a user record for the UserID to find the last fences we saw the user in.
        let getLastFences = getLastKnownFencesForUser(userId, arcgisToken);

        if (routeId === undefined) {
            console.log('Updating location only!');
            // We just want to update the user record.
            return getLastFences.then((results) => {
                return updateUserLocationOnly(userId, arcgisToken);
            });
        }

        // Get the fences that the updated lat/lng are in
        let getCurrentFences = getFencesForLocation(newLat, newLng, routeId, sequence, arcgisToken);

        return promise.all([getLastFences, getCurrentFences]).then((results) => {
            let currentFences = request.message.currentFences;
            let oldFences = request.message.oldFences;
            let enteredFences = currentFences.filter(function (newFence) {
                return oldFences.indexOf(newFence) < 0;
            });
            let exitedFences = oldFences.filter(function (oldFence) {
                return currentFences.indexOf(oldFence) < 0;
            });
            // console.log('Old fences', request.message.oldFences);
            // console.log('New fences', request.message.currentFences);
            // console.log('Entered', enteredFences);
            // console.log('Exited', exitedFences);
            request.message.enteredFences = enteredFences;
            request.message.exitedFences = exitedFences;

            if (enteredFences.length > 0) {
                pubnubPublishDeliveryImminent(userId, routeId, sequence);
            }

            return updateUserWithGeofences(currentFences, arcgisToken);
        }).catch((errs) => {
            console.log('Error happened fetching old and new geofences: ', errs);
            return request.abort();
        });
    }).catch((errs) => {
        console.log('Error getting token', errs);
        return request.abort();
    });


    // Notification Functions
    function pubnubPublishDeliveryImminent(driverId, routeId, sequence) {
        // We're getting close to the user. Let them know!
        let channelId = `deliveryImminent+${routeId}`;
        let channelIdForDelivery = `deliveryImminent+${routeId}+${sequence}`;
        let message = {
            driverId: driverId,
            routeId: routeId,
            sequence: sequence,
            message: "Your delivery is about 5 minutes away"
        };

        console.log(`Imminent Delivery Alert on channel ${channelId}`);
        pubnub.publish({
            channel: channelId,
            message: message
        }).then((publishResponse) => {
            // console.log(`Publish Status: ${publishResponse[0]}:${publishResponse[1]} with TT ${publishResponse[2]}`);
        });

        console.log(`Imminent Delivery Alert on channel ${channelIdForDelivery}`);
        pubnub.publish({
            channel: channelIdForDelivery,
            message: message
        }).then((publishResponse) => {
            // console.log(`Publish Status: ${publishResponse[0]}:${publishResponse[1]} with TT ${publishResponse[2]}`);
        });
    }

    function pubnubPublishDriverLocation(driverId, lat, lon, routeId, sequence) {
        let channelId = `driverLocation+${driverId}`;
        let message = {
            driverId: driverId,
            lat: lat,
            lon: lon
        };
        if (routeId !== undefined && sequence !== undefined) {
            message.routeId = routeId;
            message.sequence = sequence;
        }
        // console.log(`Driver Location Update on channel ${channelId}`);
        pubnub.publish({
            channel: channelId,
            message: message
        }).then((publishResponse) => {
            // console.log(`Publish Status: ${publishResponse[0]}:${publishResponse[1]} with TT ${publishResponse[2]}`);
        });
    }


    // ArcGIS Functions
    function getFencesForLocation(lat, lng, routeId, sequence, token) {
        let currentFencesQueryParams = getGeofenceQueryParams(lat, lng, routeId, sequence);
        let queryCurrentFencesURL = `${geofencesURL}/query?${query.stringify(currentFencesQueryParams)}&token=${token}`;

        return xhr.fetch(queryCurrentFencesURL).then((response) => {
            return response.json().then((parsedResponse) => {
                // console.log('featuresForGeofence ', currentFencesQueryParams.where, parsedResponse.features);
                let currentGeofences = (parsedResponse.features || []).map(function (f) {
                    return `${f.attributes.OBJECTID}`;
                });
                request.message.currentFences = currentGeofences;
                return request.ok();
            }).catch((err) => {
                console.log('Error happened parsing the new geofences JSON', err);
                return request.abort();
            });
        }).catch((err) => {
            console.log('Error happened fetching the new geofences', err);
            return request.abort();
        });
    }

    function getLastKnownFencesForUser(userId, token) {
        let oldFencesQueryParams = getUserFencesQueryParams(userId);
        let queryOldFencesURL = `${usersURL}/query?${query.stringify(oldFencesQueryParams)}&token=${token}`;

        return xhr.fetch(queryOldFencesURL).then((response) => {
            return response.json().then((parsedResponse) => {
                if (parsedResponse.error) {
                    console.log(parsedResponse.error);
                    return request.abort();
                }

                if (parsedResponse.features.length == 0) {
                    console.log(`Could not find user ${userId}`);
                    return request.abort();
                }
                let oldGeofences = parsedResponse.features.map(function (f) {
                    return (f.attributes.Geofences || '').split(',');
                })[0];
                if (parsedResponse.features.length > 0) {
                    // If this exists, we update later, else we add later.
                    request.message.existingUserOID = parsedResponse.features[0].attributes.OBJECTID;
                }
                oldGeofences = oldGeofences || [];
                request.message.oldFences = oldGeofences;
                return request.ok();
            }).catch((err) => {
                console.log('Error happened parsing the old geofences response JSON', err);
                return request.abort();
            });
        }).catch((err) => {
            console.log('Error happened fetching the old geofences', err);
            return request.abort();
        });
    }

    function updateUserLocationOnly(userId, token) {
        if (request.message.existingUserOID !== undefined) {
            console.log(`No RouteID. Updating existing location only for ${userId}.`);
            return updateUserWithGeofences(undefined, token);
        } else {
            // Nothing to update
            console.log(`Could not find user ${userId}`);
            return request.abort();
        }
    }

    function updateUserWithGeofences(currentFences, token) {
        let userUpdateAction;
        let userJSON = {
            geometry: {
                'x': newLng,
                'y': newLat,
                'spatialReference': {
                    'wkid': 4326
                }
            }, 
            attributes: {}
        };

        if (currentFences !== undefined) {
            userJSON.attributes.Geofences = currentFences.join();
        }

        if (request.message.existingUserOID === undefined) {

            // Adding new user
            userJSON.attributes.UserID = userId;
            userUpdateAction = "adds";

        } else {

            // Updating existing user (the record already has the UserID)
            userJSON.attributes.OBJECTID = request.message.existingUserOID;
            userUpdateAction = "updates";

        }

        // We don't need to pass this back.
        delete request.message.existingUserOID;

        let userUpdateBody = `f=json&${userUpdateAction}=${JSON.stringify(userJSON)}&token=${token}`;

        let postOptions = {
            "method": "POST",
            "headers": {
                "Content-Type": "application/x-www-form-urlencoded"
            },
            "body": userUpdateBody
        };

        let addUpdateUserURL = `${usersURL}/applyEdits`;

        // Now update or create the user record with the current fences listed.            
        return xhr.fetch(addUpdateUserURL, postOptions).then((updateResponse) => {
            return updateResponse.json().then((parsedResponse) => {
                let result, writeType;

                if (parsedResponse.addResults.length > 0) {
                    result = parsedResponse.addResults[0];
                    writeType = "Add";
                } else if (parsedResponse.updateResults.length > 0) {
                    result = parsedResponse.updateResults[0];
                    writeType = "Update";
                } else {
                    console.log('No add or update result returned. This is unexpected.');
                    return request.abort('No add or update result returned. This is unexpected.');
                }

                if (result.success) {
                    // console.log(`${writeType} completed successfully for ${userId}`, result);
                    request.message.arcgisObjectId = result.objectId;
                    return request.ok();
                } else {
                    return request.abort('Add or Update user in ArcGIS failed.');
                }
            }).catch((err) => {
                console.log('Error happened on parsing the user update response JSON', err);
                return request.abort();
            });
        }).catch((err) => {
            console.log('Error happened POSTing a user update', err);
            return request.abort();
        });
    }

    // Token
    function getToken(CLIENT_ID, CLIENT_SECRET) {
        const store = require('kvstore');

        return store.getItem('arcgisToken').then((value) => {
            if (value !== "null") {
                request.message.arcgisToken = value;
                // console.log(`Token Exists: ${value}`);
                return request;
            } else {
                // console.log('Need to get new token');
                const xhr = require('xhr');
                const url = "https://www.arcgis.com/sharing/rest/oauth2/token/";

                const http_options = {
                    "method": "POST",
                    "headers": {
                        "Content-Type": "application/x-www-form-urlencoded"
                    },

                    "body": "&client_id=" + CLIENT_ID +
                        "&grant_type=client_credentials" +
                        "&client_secret=" + CLIENT_SECRET
                };

                return xhr.fetch(url, http_options).then((x) => {
                    const body = JSON.parse(x.body);

                    // Store the token, and forget it 5 minutes before ArcGIS starts rejecting it.
                    store.setItem('arcgisToken', body.access_token, (body.expires_in / 60) - 5);
                    request.message.arcgisToken = body.access_token;

                    // console.log(`Stored new token to expire in ${(body.expires_in/60) - 5} minutes: ${body.access_token}`);

                    return request;
                }).catch((x) => {
                    console.log("Exception in token xhr request: " + x);
                    return request.abort();
                });
            }
        });
    }
};

function getGeofenceQueryParams(lat, lng, routeId, sequence) {
    // For more information on querying a feature service's layer, see:
    // http://resources.arcgis.com/en/help/arcgis-rest-api/#/Query_Feature_Service_Layer/02r3000000r1000000/
    // 
    // Here we'll query by geometry to see which geofences the updated user position falls within.
    var queryParams = {
        geometryType: 'esriGeometryPoint',
        geometry: `${lng},${lat}`,
        inSR: 4326,
        spatialRel: 'esriSpatialRelIntersects',
        outFields: 'OBJECTID',
        returnGeometry: false,
        f: 'json'
    };

    if (routeId !== undefined) {
        queryParams.where = `RouteID = '${routeId}'`;
        if (sequence !== undefined) {
            queryParams.where = queryParams.where + ` AND Sequence = ${sequence}`
        }
    }

    return queryParams;
}

function getUserFencesQueryParams(userId) {
    // For more information on querying a feature service's layer, see:
    // http://resources.arcgis.com/en/help/arcgis-rest-api/#/Query_Feature_Service_Layer/02r3000000r1000000/
    //
    // Here we query by UserID to get the last known geofences the user was within.
    return {
        where: `GlobalID = '${userId}'`,
        outFields: 'OBJECTID,GlobalID,Name,Geofences',
        returnGeometry: false,
        resultRecordCount: 1,
        f: 'json'
    };
}