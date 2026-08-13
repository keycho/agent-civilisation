/**
 * RD New (EPSG:28992) <-> WGS84.
 *
 * Schreutelkamp & Strang van Hees approximation polynomials. Accurate to
 * roughly a quarter of a metre across the Netherlands, which is far inside the
 * tolerance for matching a BAG footprint to the OSM way that carries its tags.
 *
 * 3DBAG ships its geometry in RD metres, and RD is already a metric projection,
 * so the chunk-local frame is RD minus an origin. That means real footprints
 * reach the renderer with no reprojection error at all — WGS84 is only needed
 * for the PostGIS columns and for talking to OSM.
 */

const LAT0 = 52.1551744
const LON0 = 5.38720621
const X0 = 155000
const Y0 = 463000

export interface LatLon {
  lat: number
  lon: number
}

export interface RdPoint {
  x: number
  y: number
}

const RD_TO_LAT: Array<[number, number, number]> = [
  // [powX, powY, coefficient]
  [0, 1, 3235.65389],
  [2, 0, -32.58297],
  [0, 2, -0.2475],
  [2, 1, -0.84978],
  [0, 3, -0.0655],
  [2, 2, -0.01709],
  [1, 0, -0.00738],
  [4, 0, 0.0053],
  [2, 3, -0.00039],
  [4, 1, 0.00033],
  [1, 1, -0.00012],
]

const RD_TO_LON: Array<[number, number, number]> = [
  [1, 0, 5260.52916],
  [1, 1, 105.94684],
  [1, 2, 2.45656],
  [3, 0, -0.81885],
  [1, 3, 0.05594],
  [3, 1, -0.05607],
  [0, 1, 0.01199],
  [3, 2, -0.00256],
  [1, 4, 0.00128],
  [0, 2, 0.00022],
  [2, 0, -0.00022],
  [5, 0, 0.00026],
]

export function rdToWgs(x: number, y: number): LatLon {
  const dX = (x - X0) * 1e-5
  const dY = (y - Y0) * 1e-5
  let sumN = 0
  for (const [px, py, c] of RD_TO_LAT) sumN += c * Math.pow(dX, px) * Math.pow(dY, py)
  let sumE = 0
  for (const [px, py, c] of RD_TO_LON) sumE += c * Math.pow(dX, px) * Math.pow(dY, py)
  return { lat: LAT0 + sumN / 3600, lon: LON0 + sumE / 3600 }
}

const WGS_TO_X: Array<[number, number, number]> = [
  // [powLat, powLon, coefficient]
  [0, 1, 190094.945],
  [1, 1, -11832.228],
  [2, 1, -114.221],
  [0, 3, -32.391],
  [1, 0, -0.705],
  [3, 1, -2.34],
  [1, 3, -0.608],
  [0, 2, -0.008],
  [2, 3, 0.148],
]

const WGS_TO_Y: Array<[number, number, number]> = [
  [1, 0, 309056.544],
  [0, 2, 3638.893],
  [2, 0, 73.077],
  [1, 2, -157.984],
  [3, 0, 59.788],
  [0, 1, 0.433],
  [2, 2, -6.439],
  [1, 1, -0.032],
  [0, 4, 0.092],
  [1, 4, -0.054],
]

export function wgsToRd(lat: number, lon: number): RdPoint {
  const dLat = 0.36 * (lat - LAT0)
  const dLon = 0.36 * (lon - LON0)
  let x = X0
  for (const [pa, po, c] of WGS_TO_X) x += c * Math.pow(dLat, pa) * Math.pow(dLon, po)
  let y = Y0
  for (const [pa, po, c] of WGS_TO_Y) y += c * Math.pow(dLat, pa) * Math.pow(dLon, po)
  return { x, y }
}
