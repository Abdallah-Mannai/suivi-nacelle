// ============================================================
// itineraire.js — ordre de passage optimise + trace routier OSRM
// + heures d'arrivee estimees (ETA).
//
// 1. Ordre : heuristique du plus proche voisin puis amelioration
//    2-opt, sur distances a vol d'oiseau (haversine). Suffisant pour
//    une tournee de quelques dizaines d'arrets, et ne coute AUCUN
//    appel reseau.
// 2. Trace + durees : OSRM public (gratuit, sans cle) dans l'ordre
//    trouve : https://router.project-osrm.org
// 3. ETA : durees de conduite OSRM cumulees + temps d'intervention
//    moyen par client (parametrable par l'admin).
// ============================================================

const OSRM_URL = 'https://router.project-osrm.org/route/v1/driving/';

// Distance a vol d'oiseau en metres.
function haversine(a, b) {
  const R = 6371000;
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 +
            Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Plus proche voisin : depuis « depart », visiter a chaque fois le
// point restant le plus proche. Renvoie les INDICES de « points »
// dans l'ordre de visite.
function plusProcheVoisin(depart, points) {
  const restants = points.map((_, i) => i);
  const ordre = [];
  let courant = depart;
  while (restants.length) {
    let meilleur = 0;
    let meilleureDist = Infinity;
    for (let k = 0; k < restants.length; k++) {
      const d = haversine(courant, points[restants[k]]);
      if (d < meilleureDist) { meilleureDist = d; meilleur = k; }
    }
    const idx = restants.splice(meilleur, 1)[0];
    ordre.push(idx);
    courant = points[idx];
  }
  return ordre;
}

function longueurChemin(depart, points, ordre) {
  let total = 0;
  let courant = depart;
  for (const idx of ordre) {
    total += haversine(courant, points[idx]);
    courant = points[idx];
  }
  return total;
}

// 2-opt : tant qu'inverser un troncon raccourcit le chemin, on
// inverse. Chemin OUVERT (on ne revient pas au depart).
function deuxOpt(depart, points, ordreInitial) {
  let ordre = ordreInitial.slice();
  let ameliore = true;
  let garde = 0;
  while (ameliore && garde++ < 200) {
    ameliore = false;
    for (let i = 0; i < ordre.length - 1; i++) {
      for (let j = i + 1; j < ordre.length; j++) {
        const candidat = ordre.slice(0, i)
          .concat(ordre.slice(i, j + 1).reverse(), ordre.slice(j + 1));
        if (longueurChemin(depart, points, candidat) <
            longueurChemin(depart, points, ordre) - 1) {
          ordre = candidat;
          ameliore = true;
        }
      }
    }
  }
  return ordre;
}

// Ordre de passage optimise : indices de « points » (chacun { lat, lng }).
function ordonnerPoints(depart, points) {
  if (!points.length) return [];
  if (points.length === 1) return [0];
  return deuxOpt(depart, points, plusProcheVoisin(depart, points));
}

// Vrai trace routier OSRM en passant par « etapes » dans l'ordre.
// Renvoie { geometrie: [[lat,lng],...], durees: [s leg1, s leg2, ...],
//           distance: metres } — durees.length === etapes.length.
async function itineraireOsrm(depart, etapes) {
  const coords = [depart, ...etapes]
    .map((p) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`)
    .join(';');
  const url = `${OSRM_URL}${coords}?overview=full&geometries=geojson&steps=false`;

  let reponse;
  try {
    reponse = await fetch(url);
  } catch {
    throw new Error('Calcul d’itinéraire injoignable — vérifiez la connexion.');
  }
  if (!reponse.ok) throw new Error('Service d’itinéraire indisponible, réessayez.');

  const donnees = await reponse.json();
  if (donnees.code !== 'Ok' || !donnees.routes?.length) {
    throw new Error('Aucun itinéraire routier trouvé entre ces points.');
  }

  const route = donnees.routes[0];
  return {
    geometrie: route.geometry.coordinates.map(([lng, lat]) => [lat, lng]),
    durees: route.legs.map((l) => l.duration),
    distance: route.distance,
  };
}

// ETA de chaque etape : depuis « maintenant », on cumule la conduite
// (durees OSRM) et le temps passe chez chaque client precedent.
// durees[i] = conduite jusqu'a l'etape i. Renvoie un tableau de Date.
function calculerEtas(maintenant, durees, tempsInterventionMin) {
  const etas = [];
  let cumulSecondes = 0;
  for (let i = 0; i < durees.length; i++) {
    cumulSecondes += durees[i];
    etas.push(new Date(maintenant.getTime() + cumulSecondes * 1000));
    cumulSecondes += tempsInterventionMin * 60;   // temps passe chez ce client
  }
  return etas;
}

// Pour les tests Node (les pages, elles, utilisent les globales).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { haversine, plusProcheVoisin, deuxOpt, ordonnerPoints, longueurChemin, calculerEtas };
}
