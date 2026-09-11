// ============================================================
// Tests de la logique pure (sans reseau) :
//   node --test test/
// ============================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { haversine, ordonnerPoints, longueurChemin, calculerEtas } = require('../js/itineraire.js');
const { parseLatLng, reparerAccents, dansLaZone } = require('../js/geo.js');

// ---------- geo ----------

test('parseLatLng accepte « lat;lng » avec ; ou , et virgule décimale', () => {
  assert.deepEqual(parseLatLng('50.4348;3.0891'), { lat: 50.4348, lng: 3.0891 });
  assert.deepEqual(parseLatLng(' 50,4348 ; 3,0891 '), { lat: 50.4348, lng: 3.0891 });
  assert.deepEqual(parseLatLng('48.85, 2.35'), { lat: 48.85, lng: 2.35 });
});

test('parseLatLng rejette les adresses et les valeurs impossibles', () => {
  assert.equal(parseLatLng('12 rue de la Gare, Douai'), null);
  assert.equal(parseLatLng('95;200'), null);       // lng > 180
  assert.equal(parseLatLng('91;3'), null);         // lat > 90
  assert.equal(parseLatLng(''), null);
});

test('reparerAccents corrige le mojibake courant', () => {
  assert.equal(reparerAccents('12 rue de la LibertÃ©, LiÃ©vin'), '12 rue de la Liberté, Liévin');
  assert.equal(reparerAccents('  double   espace '), 'double espace');
});

test('dansLaZone : France métropolitaine seulement', () => {
  assert.equal(dansLaZone(50.43, 3.08), true);     // Nord
  assert.equal(dansLaZone(41.9, 8.7), true);       // Corse
  assert.equal(dansLaZone(14.6, -61.0), false);    // Martinique (hors zone OSRM/BAN fiable)
  assert.equal(dansLaZone(0, 0), false);
});

// ---------- itineraire ----------

test('haversine : Lille -> Paris ≈ 204 km', () => {
  const d = haversine({ lat: 50.6292, lng: 3.0573 }, { lat: 48.8566, lng: 2.3522 });
  assert.ok(d > 190000 && d < 215000, `distance inattendue : ${d}`);
});

test('ordonnerPoints trouve l’ordre géographique évident', () => {
  const depart = { lat: 50.0, lng: 3.0 };
  // Points alignés vers le sud, donnés dans le désordre.
  const points = [
    { lat: 49.4, lng: 3.0 },   // 3e
    { lat: 49.8, lng: 3.0 },   // 1er
    { lat: 49.2, lng: 3.0 },   // 4e
    { lat: 49.6, lng: 3.0 },   // 2e
  ];
  assert.deepEqual(ordonnerPoints(depart, points), [1, 3, 0, 2]);
});

test('le 2-opt fait mieux ou aussi bien que l’ordre de saisie', () => {
  const depart = { lat: 50.63, lng: 3.06 };
  const points = [
    { lat: 50.38, lng: 3.08 }, { lat: 50.62, lng: 3.05 },
    { lat: 50.29, lng: 2.78 }, { lat: 50.52, lng: 2.88 },
    { lat: 50.43, lng: 3.09 }, { lat: 50.60, lng: 3.15 },
  ];
  const ordreSaisie = points.map((_, i) => i);
  const optimise = ordonnerPoints(depart, points);
  assert.equal(optimise.length, points.length);
  assert.deepEqual(optimise.slice().sort(), ordreSaisie.slice().sort());  // permutation complète
  assert.ok(longueurChemin(depart, points, optimise) <=
            longueurChemin(depart, points, ordreSaisie));
});

test('calculerEtas cumule conduite + temps d’intervention', () => {
  const t0 = new Date('2026-09-11T08:00:00Z');
  // 10 min de route vers A, puis 20 min vers B ; 20 min chez chaque client.
  const etas = calculerEtas(t0, [600, 1200], 20);
  assert.equal(etas[0].toISOString(), '2026-09-11T08:10:00.000Z');
  // B : 10 conduite + 20 intervention + 20 conduite = 50 min.
  assert.equal(etas[1].toISOString(), '2026-09-11T08:50:00.000Z');
});
