"""
Pulls what the bus tracker needs out of raw OpenStreetMap extracts.

    python -I tools/osm_extract.py <out-dir> <file.osm.pbf> [<file.osm.pbf> ...]

Writes, for the service area only (BBOX below):

    roads.json   every road a bus could drive: way id, highway class, name,
                 ref, oneway, and its node coordinates
    places.json  every named place a stop could be called after: villages,
                 hamlets, suburbs, junctions, bus stops, temples, schools,
                 hospitals, shops... with a representative point

Several files may be given (the area straddles Andhra Pradesh and Tamil
Nadu); ways and nodes seen twice are kept once.

Needs `pip install osmium`. Run it on the files from
https://download.openstreetmap.fr/extracts/asia/india/ — they are refreshed
daily, so a re-run each semester picks up roads mapped since.
"""

import json
import sys

import osmium

# lon/lat — Tirupati to Chittoor to Nagalapuram, with a margin.
BBOX = (78.95, 13.05, 79.95, 13.90)

# What a 40-seat bus can use. Tracks, paths and footways are left out on
# purpose: a matcher that knows about a cart track next to the highway will
# sooner or later put the bus on it.
DRIVABLE = {
    'motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link',
    'secondary', 'secondary_link', 'tertiary', 'tertiary_link', 'unclassified',
    'residential', 'living_street', 'road', 'service',
}

POI_KEYS = ('amenity', 'shop', 'tourism', 'historic', 'leisure', 'office', 'railway',
            'public_transport', 'healthcare', 'man_made', 'landuse', 'building', 'junction')


def inside(lon, lat):
    return BBOX[0] <= lon <= BBOX[2] and BBOX[1] <= lat <= BBOX[3]


def names(tags):
    out = {}
    for k in ('name', 'name:en', 'alt_name', 'old_name', 'official_name', 'short_name', 'loc_name'):
        v = tags.get(k)
        if v:
            out[k] = v
    return out


def kind(tags):
    if 'place' in tags:
        return 'place=' + tags['place']
    if tags.get('highway') == 'bus_stop' or tags.get('public_transport') in ('platform', 'stop_position'):
        return 'bus_stop'
    if tags.get('amenity') == 'bus_station':
        return 'bus_station'
    for k in POI_KEYS:
        if k in tags:
            return f'{k}={tags[k]}'
    if 'highway' in tags:
        return 'highway=' + tags['highway']
    return 'other'


class Reader(osmium.SimpleHandler):
    def __init__(self, roads, places):
        super().__init__()
        self.roads, self.places = roads, places

    def node(self, n):
        if not n.location.valid() or not inside(n.location.lon, n.location.lat):
            return
        t = {k: v for k, v in n.tags}
        nm = names(t)
        if not nm:
            return
        key = f'n{n.id}'
        if key not in self.places:
            self.places[key] = {'id': key, 'kind': kind(t), **nm,
                                'lat': round(n.location.lat, 6), 'lng': round(n.location.lon, 6)}

    def way(self, w):
        t = {k: v for k, v in w.tags}
        try:
            pts = [(round(n.lon, 6), round(n.lat, 6)) for n in w.nodes]
            ids = [n.ref for n in w.nodes]
        except osmium.InvalidLocationError:
            return
        if not pts or not any(inside(x, y) for x, y in pts):
            return
        hw = t.get('highway')
        if hw in DRIVABLE and t.get('area') != 'yes':
            if t.get('access') in ('private', 'no') and hw == 'service':
                return
            if t.get('service') in ('parking_aisle', 'driveway', 'drive-through'):
                return
            key = w.id
            if key not in self.roads:
                ow = t.get('oneway', '')
                oneway = 1 if ow in ('yes', '1', 'true') else -1 if ow == '-1' else 0
                if hw in ('motorway', 'motorway_link') or t.get('junction') == 'roundabout':
                    oneway = oneway or 1
                self.roads[key] = {'id': key, 'hw': hw, 'name': t.get('name') or t.get('name:en') or '',
                                   'ref': t.get('ref', ''), 'oneway': oneway,
                                   'ms': t.get('maxspeed', ''), 'n': ids, 'c': pts}
        nm = names(t)
        if nm and hw is None:
            key = f'w{w.id}'
            if key not in self.places:
                xs = [p[0] for p in pts]; ys = [p[1] for p in pts]
                self.places[key] = {'id': key, 'kind': kind(t), **nm,
                                    'lat': round(sum(ys) / len(ys), 6), 'lng': round(sum(xs) / len(xs), 6)}


def main():
    out, files = sys.argv[1], sys.argv[2:]
    roads, places = {}, {}
    for f in files:
        Reader(roads, places).apply_file(f, locations=True, idx='flex_mem')
        print(f'{f}: {len(roads)} roads, {len(places)} places so far', flush=True)
    with open(f'{out}/roads.json', 'w', encoding='utf8') as fh:
        json.dump(list(roads.values()), fh, separators=(',', ':'))
    with open(f'{out}/places.json', 'w', encoding='utf8') as fh:
        json.dump(list(places.values()), fh, ensure_ascii=False, separators=(',', ':'))
    print('done', len(roads), 'roads', len(places), 'places')


if __name__ == '__main__':
    main()
