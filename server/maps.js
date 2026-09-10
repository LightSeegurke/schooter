'use strict';

/**
 * Arena map definitions. Each map is the same world size but has its own
 * obstacle layout, team spawn zones and powerup spots.
 */

const WORLD = { w: 1600, h: 900 };

const MAPS = {
  arena: {
    id: 'arena',
    name: 'Arena',
    obstacles: [
      { x: 380, y: 180, w: 180, h: 40 }, { x: 1040, y: 180, w: 180, h: 40 },
      { x: 720, y: 120, w: 160, h: 160 }, { x: 200, y: 430, w: 40, h: 200 },
      { x: 1360, y: 430, w: 40, h: 200 }, { x: 700, y: 620, w: 200, h: 40 },
      { x: 380, y: 680, w: 180, h: 40 }, { x: 1040, y: 680, w: 180, h: 40 },
      { x: 720, y: 400, w: 160, h: 120 }
    ],
    powerups: [
      { x: 800, y: 90, type: 'health' }, { x: 130, y: 450, type: 'shield' },
      { x: 1470, y: 450, type: 'damage' }, { x: 800, y: 810, type: 'health' },
      { x: 300, y: 250, type: 'ammo' }, { x: 1300, y: 650, type: 'speed' }
    ],
    redSpawn: { x: 120, y: 450 },
    blueSpawn: { x: 1480, y: 450 }
  },

  bunkers: {
    id: 'bunkers',
    name: 'Bunker',
    obstacles: [
      { x: 250, y: 150, w: 260, h: 40 }, { x: 250, y: 150, w: 40, h: 200 },
      { x: 1090, y: 150, w: 260, h: 40 }, { x: 1310, y: 150, w: 40, h: 200 },
      { x: 250, y: 710, w: 260, h: 40 }, { x: 250, y: 550, w: 40, h: 200 },
      { x: 1090, y: 710, w: 260, h: 40 }, { x: 1310, y: 550, w: 40, h: 200 },
      { x: 700, y: 200, w: 200, h: 40 }, { x: 700, y: 660, w: 200, h: 40 },
      { x: 760, y: 380, w: 80, h: 140 }, { x: 540, y: 420, w: 120, h: 40 },
      { x: 940, y: 420, w: 120, h: 40 }
    ],
    powerups: [
      { x: 800, y: 100, type: 'damage' }, { x: 800, y: 800, type: 'health' },
      { x: 120, y: 450, type: 'ammo' }, { x: 1480, y: 450, type: 'ammo' },
      { x: 400, y: 450, type: 'shield' }, { x: 1200, y: 450, type: 'speed' }
    ],
    redSpawn: { x: 140, y: 450 },
    blueSpawn: { x: 1460, y: 450 }
  },

  pillars: {
    id: 'pillars',
    name: 'Säulen',
    obstacles: (() => {
      const o = [];
      for (let gx = 0; gx < 5; gx++) {
        for (let gy = 0; gy < 3; gy++) {
          o.push({ x: 300 + gx * 250, y: 210 + gy * 240, w: 70, h: 70 });
        }
      }
      return o;
    })(),
    powerups: [
      { x: 800, y: 450, type: 'damage' }, { x: 200, y: 200, type: 'health' },
      { x: 1400, y: 700, type: 'health' }, { x: 1400, y: 200, type: 'shield' },
      { x: 200, y: 700, type: 'ammo' }, { x: 800, y: 100, type: 'speed' }
    ],
    redSpawn: { x: 120, y: 450 },
    blueSpawn: { x: 1480, y: 450 }
  }
};

const MAP_LIST = Object.values(MAPS).map((m) => ({ id: m.id, name: m.name }));

function getMap(id) {
  return MAPS[id] || MAPS.arena;
}

function randomMapId() {
  const ids = Object.keys(MAPS);
  return ids[Math.floor(Math.random() * ids.length)];
}

module.exports = { WORLD, MAPS, MAP_LIST, getMap, randomMapId };
