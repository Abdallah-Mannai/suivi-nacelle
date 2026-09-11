// ============================================================
// geo.js — geocodage (Base Adresse Nationale) et saisie de
// coordonnees « lat;lng », avec garde-fous.
// Gratuit, sans cle : https://api-adresse.data.gouv.fr
// ============================================================

const BAN_URL = 'https://api-adresse.data.gouv.fr/search/';

// France metropolitaine (Corse comprise) : tout point geocode hors
// de cette boite est rejete — un score BAN moyen sur une adresse mal
// tapee peut renvoyer l'autre bout du pays, pas l'autre bout du monde.
const ZONE = { latMin: 41.0, latMax: 51.5, lngMin: -5.8, lngMax: 10.0 };

// En dessous de ce score BAN, l'adresse est jugee trop incertaine
// pour envoyer un nacelliste dessus : on demande de la preciser.
const SCORE_MIN = 0.4;

function dansLaZone(lat, lng) {
  return lat >= ZONE.latMin && lat <= ZONE.latMax &&
         lng >= ZONE.lngMin && lng <= ZONE.lngMax;
}

// Adresses copiees depuis des exports mal encodes : « Ã© » est en
// realite « é ». On repare les sequences les plus courantes avant
// d'interroger la BAN.
const MOJIBAKE = [
  ['Ã©', 'é'], ['Ã¨', 'è'], ['Ãª', 'ê'], ['Ã«', 'ë'],
  ['Ã ', 'à'], ['Ã¢', 'â'], ['Ã®', 'î'], ['Ã¯', 'ï'],
  ['Ã´', 'ô'], ['Ã¶', 'ö'], ['Ã¹', 'ù'], ['Ã»', 'û'],
  ['Ã§', 'ç'], ['Å“', 'œ'], ['â€™', '’'], ['Ã‰', 'É'],
];

function reparerAccents(texte) {
  let t = String(texte || '');
  for (const [casse, propre] of MOJIBAKE) t = t.split(casse).join(propre);
  return t.normalize('NFC').replace(/\s+/g, ' ').trim();
}

// « 50.434800;3.089118 » (ou avec virgule decimale, ou separe par une
// virgule) -> { lat, lng }, ou null si ce n'est pas des coordonnees.
function parseLatLng(saisie) {
  const s = String(saisie || '').trim();
  const m = s.match(/^(-?\d{1,2}(?:[.,]\d+)?)\s*[;,]\s*(-?\d{1,3}(?:[.,]\d+)?)$/);
  if (!m) return null;
  const lat = parseFloat(m[1].replace(',', '.'));
  const lng = parseFloat(m[2].replace(',', '.'));
  if (!isFinite(lat) || !isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

// Geocode une adresse via la BAN. Renvoie { lat, lng, label } ou
// jette une erreur EXPLICITE (affichable telle quelle au nacelliste).
async function geocoderAdresse(adresse) {
  const propre = reparerAccents(adresse);
  if (propre.length < 5) throw new Error('Adresse trop courte.');

  const url = `${BAN_URL}?q=${encodeURIComponent(propre)}&limit=1`;
  let reponse;
  try {
    reponse = await fetch(url);
  } catch {
    throw new Error('Service d’adresses injoignable — vérifiez la connexion.');
  }
  if (!reponse.ok) throw new Error('Service d’adresses indisponible, réessayez.');

  const donnees = await reponse.json();
  const resultat = donnees.features && donnees.features[0];
  if (!resultat) throw new Error(`Adresse introuvable : « ${propre} ».`);

  const score = resultat.properties?.score ?? 0;
  if (score < SCORE_MIN) {
    throw new Error(`Adresse trop imprécise (« ${resultat.properties?.label ?? '?'} » ?) — précisez la ville ou le code postal.`);
  }

  const [lng, lat] = resultat.geometry.coordinates;
  if (!dansLaZone(lat, lng)) {
    throw new Error('Adresse hors zone (France métropolitaine attendue).');
  }

  return { lat, lng, label: resultat.properties.label, score };
}

// Pour les tests Node (les pages, elles, utilisent les globales).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseLatLng, reparerAccents, dansLaZone, SCORE_MIN };
}
