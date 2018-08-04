// Copyright (c) 2018 Marcus Hultman

'use strict';

const axios = require('axios');
const functions = require('firebase-functions');

const {
  dialogflow,
  BasicCard,
  Button,
  Permission,
  Place,
} = require('actions-on-google');

process.env.DEBUG = 'dialogflow:debug'; // enables lib debugging statements

const deg2rad = deg => deg * Math.PI / 180;

function distance(lat1, lon1, lat2, lon2) {
  const dLat = deg2rad(lat2 - lat1);
  const dLon = deg2rad(lon2 - lon1);
  const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(deg2rad(lat1)) * Math.cos(deg2rad(lat2)) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function stationsSortedByDistance(stations, { latitude, longitude }) {
  stations.sort((lhs, rhs) => {
    const lhsDist = distance(latitude, longitude, lhs.position.lat, lhs.position.lng);
    const rhsDist = distance(latitude, longitude, rhs.position.lat, rhs.position.lng);
    return lhsDist - rhsDist;
  });
  return stations;
}

function getStationsForCoords(coords) {
  const { url, key} = functions.config().api;
  return axios.get(url, { params: { contract: 'Goteborg', apiKey: key }})
  .then(response => response.data)
  .then(stations => stationsSortedByDistance(stations, coords));
}

const kStationOpen = 'OPEN';
const kStationMinEntityCount = 3;

const isOpen = station => station.status === kStationOpen;
const hasBikes = station => station.available_bikes >= kStationMinEntityCount;
const hasStands = station => station.available_bike_stands >= kStationMinEntityCount;

function isSuggested(station, type) {
  return (type === 'stands' ? hasStands(station) : hasBikes(station)) && isOpen(station);
}

function stationSpoken(station, type) {
  const { address, available_bike_stands, available_bikes } = station;
  return type === 'stands'
      ? `There are ${available_bike_stands} available bike stands at ${address}.`
      : `There are ${available_bikes} available bikes at ${address}.`;
}

function stationText(station, type, include_address) {
  const { available_bike_stands, available_bikes } = station;
  if (include_address) {
    return `**${station.address}**  \n${stationText(station, type)}`;
  }
  return type === 'stands' ? `Stands: ${available_bike_stands}  (bikes: ${available_bikes})`
                           : `Bikes: ${available_bikes}  (stands: ${available_bike_stands})`;
}

function finishWithStations(conv, stations, type) {
  stations = stations.filter(station => isSuggested(station, type)).slice(0, 3);
  console.log('stations:', stations);
  const topStation = stations[0];
  conv.close(stationSpoken(topStation, type));
  if (!conv.screen) {
    return;
  }
  conv.close(new BasicCard({
    title: topStation.address,
    text: stations.map((station, i) => stationText(station, type, i > 0)).join('  \n'),
    buttons: new Button({
      title: 'Directions',
      url: `https://www.google.com/maps/?q=${topStation.position.lat},${topStation.position.lng}`,
    })
  }));
}

const app = dialogflow();

app.intent('place', (conv, params) => {
  console.log('place - user:', conv.user);
  console.log('place - params:', params);

  conv.ask(new Place({
    context: 'To find a station',
    prompt: 'Which station?',
  }));
});

app.intent('place.done', (conv, params, place) => {
  console.log('place.done - place', place);
  console.log('place.done - params:', params);

  if (!place || !place.coordinates) {
    return conv.close(`Sorry, I couldn't find any station.`);
  }
  return getStationsForCoords(place.coordinates)
  .then(stations => finishWithStations(conv, stations, params.type))
  .catch(err => conv.add(`Sorry, the service seem unavailable right now.`));
});

app.intent('near', (conv, params) => {
  console.log('near - user:', conv.user);
  console.log('near - params:', params);

  conv.ask(new Permission({
    context: 'To find the nearest station',
    permissions: 'DEVICE_PRECISE_LOCATION'
  }));
});

app.intent('near.done', (conv, params) => {
  const { location } = conv.device;
  console.log('near.done - location:', location);
  console.log('near.done - params:', params);

  if (!location || !location.coordinates) {
    return conv.close(`Sorry, I couldn't find any station.`);
  }
  return getStationsForCoords(location.coordinates)
  .then(stations => finishWithStations(conv, stations, params.type))
  .catch(err => conv.add(`Sorry, the service seem unavailable right now.`));
});

exports.fulfillment = functions
    .region('europe-west1')
    .https
    .onRequest(app);
