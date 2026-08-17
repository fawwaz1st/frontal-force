import * as THREE from 'three';

export type MapTheme = 'sci-fi' | 'urban' | 'military' | 'desert' | 'forest';

export class MapGenerator {
  public generate(theme: MapTheme, scene: THREE.Scene) {
    const ground = new THREE.Mesh(
      new THREE.BoxGeometry(80, 1, 80),
      new THREE.MeshStandardMaterial({ color: this.themeColor(theme), roughness: 1 })
    );
    ground.position.y = -1.5;
    scene.add(ground);
    for (let i = 0; i < 32; i++) {
      const size = 0.6 + (i % 5) * 0.5;
      const block = new THREE.Mesh(
        new THREE.BoxGeometry(size, 0.8 + (i % 4), size),
        new THREE.MeshStandardMaterial({ color: new THREE.Color().setHSL(0.58, 0.18, 0.2 + i * 0.008), roughness: 0.8 })
      );
      block.position.set(Math.sin(i * 0.9) * 12, -0.5 + (i % 2) * 0.6, Math.cos(i * 0.7) * 12);
      scene.add(block);
    }
    for (let i = 0; i < 10; i++) {
      const tower = new THREE.Mesh(
        new THREE.CylinderGeometry(0.8, 1.2, 6 + (i % 4) * 2, 6),
        new THREE.MeshStandardMaterial({ color: 0x3f516b, roughness: 0.7 })
      );
      tower.position.set(Math.cos(i) * 18, 1.5, Math.sin(i * 1.2) * 18);
      scene.add(tower);
    }
  }

  private themeColor(theme: MapTheme) {
    switch (theme) {
      case 'sci-fi': return 0x0a1628;
      case 'urban': return 0x1a1a2e;
      case 'military': return 0x1b2a1b;
      case 'desert': return 0x3a3020;
      case 'forest': return 0x142010;
    }
  }
}