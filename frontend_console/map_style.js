// Dispatch console basemap: a dark, Apple-Maps-like style drawn from OpenStreetMap vector tiles.
//
// TILE SOURCE (Section 8.6). The demo uses OpenFreeMap: free, no key, OpenMapTiles schema.
// For deployment, point TILES and GLYPHS at a self-hosted OpenMapTiles/Planetiler file; the layers
// below stay the same. No sprite sheet: points of interest are coloured dots with labels.
const BEACON_STYLE = (() => {
  const TILES = "https://tiles.openfreemap.org/planet";                       // <- swap for self-hosted
  const GLYPHS = "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf"; // <- and fonts
  const F = { reg: ["Noto Sans Regular"], bold: ["Noto Sans Bold"], ital: ["Noto Sans Italic"] };
  const C = {
    bg: "#1d2025", park: "#1e3226", wood: "#1b2e22", water: "#0f2a3e", campus: "#252838", hospital: "#3a2329",
    parking: "#262b33", building: "#30353d", buildingTop: "#3a4049",
    road: "#3a3f47", roadMajor: "#525a64", motorway: "#8b6f3e", path: "#4a515b",
    label: "#c9d1d9", labelDim: "#8f9aa6", halo: "#1d2025",
  };
  const name = ["coalesce", ["get", "name:en"], ["get", "name:latin"], ["get", "name"]];
  const zw = (pairs) => ["interpolate", ["exponential", 1.6], ["zoom"], ...pairs];

  // POI colour by OpenMapTiles class (matches the landmark colours in backend/landmarks.js).
  const poiColor = ["match", ["get", "class"],
    ["police", "fire_station"], "#4ea1ff",
    ["hospital", "doctors", "pharmacy", "dentist"], "#ff5a6e",
    ["college", "school", "library", "town_hall", "theatre", "museum", "art_gallery"], "#b8a6ff",
    ["parking", "car"], "#5b8def",
    ["bus", "railway", "attraction"], "#2bb3c0",
    ["park", "pitch", "stadium", "sports_centre", "swimming", "golf", "playground", "garden"], "#4fbf72",
    ["restaurant", "fast_food", "cafe", "bar", "beer", "ice_cream", "bakery"], "#f2a93b",
    "#9aa7b4"];

  return {
    version: 8,
    name: "BEACON dark",
    glyphs: GLYPHS,
    sources: { omt: { type: "vector", url: TILES } },
    layers: [
      { id: "bg", type: "background", paint: { "background-color": C.bg } },
      { id: "landcover", type: "fill", source: "omt", "source-layer": "landcover",
        filter: ["in", ["get", "class"], ["literal", ["grass", "wood", "farmland", "wetland"]]],
        paint: { "fill-color": ["match", ["get", "class"], "wood", C.wood, C.park], "fill-opacity": 0.9 } },
      { id: "landuse", type: "fill", source: "omt", "source-layer": "landuse",
        filter: ["in", ["get", "class"], ["literal", ["university", "college", "school", "hospital", "stadium", "pitch", "cemetery"]]],
        paint: { "fill-color": ["match", ["get", "class"], "hospital", C.hospital, ["stadium", "pitch", "cemetery"], C.park, C.campus] } },
      { id: "park", type: "fill", source: "omt", "source-layer": "park", paint: { "fill-color": C.park } },
      { id: "water", type: "fill", source: "omt", "source-layer": "water", paint: { "fill-color": C.water } },
      { id: "waterway", type: "line", source: "omt", "source-layer": "waterway", paint: { "line-color": C.water, "line-width": zw([12, 1, 18, 4]) } },
      { id: "aeroway", type: "fill", source: "omt", "source-layer": "aeroway", filter: ["==", ["geometry-type"], "Polygon"], paint: { "fill-color": C.parking } },

      // Roads: paths are dashed and only appear when zoomed in, so walkways on campus read as walkways.
      { id: "path", type: "line", source: "omt", "source-layer": "transportation", minzoom: 15,
        filter: ["in", ["get", "class"], ["literal", ["path", "track"]]],
        paint: { "line-color": C.path, "line-width": zw([15, 0.8, 19, 2]), "line-dasharray": [2, 1.5] } },
      { id: "road-minor", type: "line", source: "omt", "source-layer": "transportation",
        filter: ["in", ["get", "class"], ["literal", ["minor", "service", "raceway"]]],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": C.road, "line-width": zw([13, 0.5, 16, 4, 20, 22]) } },
      { id: "road-mid", type: "line", source: "omt", "source-layer": "transportation",
        filter: ["in", ["get", "class"], ["literal", ["tertiary", "secondary"]]],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": C.roadMajor, "line-width": zw([10, 0.8, 16, 7, 20, 34]) } },
      { id: "road-major", type: "line", source: "omt", "source-layer": "transportation",
        filter: ["in", ["get", "class"], ["literal", ["primary", "trunk"]]],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": C.roadMajor, "line-width": zw([8, 1, 16, 9, 20, 40]) } },
      { id: "motorway", type: "line", source: "omt", "source-layer": "transportation",
        filter: ["==", ["get", "class"], "motorway"],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": C.motorway, "line-width": zw([6, 1, 16, 10, 20, 44]) } },

      // Buildings rise in 3D when the map is tilted, like Apple Maps.
      { id: "building", type: "fill-extrusion", source: "omt", "source-layer": "building", minzoom: 14,
        paint: {
          "fill-extrusion-color": ["interpolate", ["linear"], ["coalesce", ["get", "render_height"], 6], 0, C.building, 40, C.buildingTop],
          "fill-extrusion-height": ["coalesce", ["get", "render_height"], 6],
          "fill-extrusion-base": ["coalesce", ["get", "render_min_height"], 0],
          "fill-extrusion-opacity": 0.92,
        } },

      // Labels, least to most important (later layers win collisions).
      { id: "road-label", type: "symbol", source: "omt", "source-layer": "transportation_name", minzoom: 13,
        filter: ["!", ["in", ["get", "class"], ["literal", ["path", "track"]]]],
        layout: { "symbol-placement": "line", "text-field": name, "text-font": F.reg, "text-size": zw([13, 10, 18, 14]), "text-max-angle": 30 },
        paint: { "text-color": C.labelDim, "text-halo-color": C.halo, "text-halo-width": 1.5 } },
      { id: "poi-dot", type: "circle", source: "omt", "source-layer": "poi", minzoom: 14,
        filter: ["has", "name"],
        paint: { "circle-color": poiColor, "circle-radius": ["interpolate", ["linear"], ["zoom"], 14, 3, 18, 6],
                 "circle-stroke-color": C.halo, "circle-stroke-width": 1.5 } },
      { id: "poi-label", type: "symbol", source: "omt", "source-layer": "poi", minzoom: 14,
        filter: ["has", "name"],
        layout: { "text-field": name, "text-font": F.reg, "text-size": ["interpolate", ["linear"], ["zoom"], 14, 10.5, 18, 13],
                  "text-anchor": "top", "text-offset": [0, 0.7], "text-max-width": 8, "symbol-sort-key": ["get", "rank"] },
        paint: { "text-color": poiColor, "text-halo-color": C.halo, "text-halo-width": 1.6 } },
      { id: "water-label", type: "symbol", source: "omt", "source-layer": "water_name",
        layout: { "text-field": name, "text-font": F.ital, "text-size": 12 }, paint: { "text-color": "#5d8fb3", "text-halo-color": C.halo, "text-halo-width": 1 } },
      { id: "place-label", type: "symbol", source: "omt", "source-layer": "place",
        layout: { "text-field": name, "text-font": F.bold, "text-size": ["match", ["get", "class"], ["city", "town"], 15, 12], "text-transform": "uppercase", "text-letter-spacing": 0.08 },
        paint: { "text-color": C.labelDim, "text-halo-color": C.halo, "text-halo-width": 1.5 } },
    ],
  };
})();
