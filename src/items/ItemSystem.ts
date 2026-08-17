export type ItemKind = 'health' | 'armor' | 'ammo' | 'weapon' | 'power' | 'tool' | 'key';

export interface ItemPickup {
  kind: ItemKind;
  name: string;
  rarity: 'common' | 'rare' | 'epic' | 'legendary';
}

export const itemCatalog: ItemPickup[] = [
  { kind: 'health', name: 'Health Pack', rarity: 'common' },
  { kind: 'armor', name: 'Armor Plate', rarity: 'common' },
  { kind: 'ammo', name: 'Ammo Crate', rarity: 'common' },
  { kind: 'weapon', name: 'Weapon Cache', rarity: 'rare' },
  { kind: 'power', name: 'Speed Boost', rarity: 'rare' },
  { kind: 'tool', name: 'Grenade Kit', rarity: 'rare' },
  { kind: 'key', name: 'Access Key', rarity: 'epic' },
];
