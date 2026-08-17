import * as THREE from 'three';
import { createHud } from './Hud';
import { InputSystem } from './InputSystem';
import { PhysicsWorld } from '../physics/PhysicsWorld';
import { PlayerController } from '../player/PlayerController';
import { WeaponSystem } from '../combat/WeaponSystem';
import { CombatSystem } from '../combat/CombatSystem';
import { SpatialAudio } from '../audio/SpatialAudio';
import { MapGenerator } from '../maps/MapGenerator';
import { Progression } from '../progression/Progression';
import { SkillTree } from '../progression/SkillTree';
import { gameModes } from '../modes/GameModes';
import { ModeManager } from '../modes/ModeManager';
import { itemCatalog } from '../items/ItemSystem';
import { PickupSystem } from '../items/PickupSystem';
import { Agents } from '../ai/Agents';

export class Game {
  private readonly container: HTMLDivElement;
  private readonly scene = new THREE.Scene();
  private readonly renderer: any;
  private readonly input = new InputSystem();
  private readonly hud = createHud();
  private readonly physics = new PhysicsWorld();
  private readonly player = new PlayerController(this.physics);
  private readonly weapon = new WeaponSystem();
  private readonly combat = new CombatSystem(this.scene, this.weapon);
  private readonly audio = new SpatialAudio();
  private readonly progression = new Progression();
  private readonly skillTree = new SkillTree();
  private readonly modeManager = new ModeManager();
  private readonly pickups = new PickupSystem();
  private readonly agents = new Agents();
  private readonly mapGenerator = new MapGenerator();
  private readonly clock = new THREE.Clock();
  private mode: 'webgpu' | 'webgl' = 'webgl';
  private readonly status = {
    enemyCount: 12,
    allyCount: 1,
    currentMode: gameModes[0],
    weapon: '',
    level: 1,
    xp: 0,
    map: 'sci-fi facility',
    items: itemCatalog.length,
  };

  public constructor(container: HTMLDivElement) {
    this.container = container;
    this.container.classList.add('game-shell');
    this.container.appendChild(this.hud.root);
    this.scene.fog = new THREE.FogExp2(0x09111f, 0.03);
    this.player.rig.position.set(0, 1.8, 6);
    this.scene.add(this.player.rig);
    this.renderer = this.createRenderer();
    this.container.appendChild(this.renderer.domElement);
    this.input.attach(this.renderer.domElement, this.hud);
    this.mapGenerator.generate('sci-fi', this.scene);
    this.progression.registerSkills(this.skillTree.list());
    this.seedAgents();
    this.seedPickups();
    window.addEventListener('resize', this.onResize);
    void this.audio.unlock();
  }

  public async start() {
    await this.physics.init();
    await this.renderer.init?.();
    this.onResize();
    this.clock.start();
    this.loop();
  }

  private createRenderer() {
    if ('WebGPURenderer' in THREE) {
      this.mode = 'webgpu';
      const Renderer = (THREE as typeof THREE & { WebGPURenderer: new (options: any) => any }).WebGPURenderer;
      return new Renderer({ antialias: true, alpha: false });
    }
    this.mode = 'webgl';
    return new THREE.WebGLRenderer({ antialias: true, alpha: false });
  }

  private loop = () => {
    const delta = Math.min(this.clock.getDelta(), 0.05);
    this.physics.step(delta);
    const cameraEye = this.player.update(delta, this.input);
    this.weapon.update(delta);
    this.pickups.update(delta);
    this.agents.update(delta, this.player.rig.position);
    const snap = this.input.snapshot();
    if (snap.weaponSlot > 0) this.weapon.select(snap.weaponSlot);
    if (snap.reload) this.weapon.reload();
    if (snap.shoot) {
      const origin = this.player.camera.getWorldPosition(new THREE.Vector3());
      const hit = this.combat.fire(origin, new THREE.Vector3(0, 0, -1));
      if (hit.hit) {
        this.audio.playSpatialTone(880, origin.x, origin.z);
        this.progression.addXp(8);
      }
    }
    if (snap.interact) this.modeManager.next();
    if (snap.crouch && snap.jump && this.progression.getSkillPoints() > 0) this.progression.unlockSkill('ally-ai');
    this.status.weapon = this.weapon.status();
    this.status.level = this.progression.getLevel();
    this.status.xp = this.progression.getXp();
    this.status.currentMode = this.modeManager.current();
    this.status.enemyCount = this.agents.all().filter((agent) => agent.role !== 'ally').length;
    this.status.allyCount = this.agents.all().filter((agent) => agent.role === 'ally').length;
    this.hud.setStatus(this.mode, this.status, this.input.getStatus(), this.weapon.status(), this.progression.getLevel(), this.progression.getXp(), this.progression.getSkillPoints());
    this.renderer.render(this.scene, this.player.camera);
    window.requestAnimationFrame(this.loop);
  };

  private onResize = () => {
    const width = this.container.clientWidth || window.innerWidth;
    const height = this.container.clientHeight || window.innerHeight;
    this.player.camera.aspect = width / height;
    this.player.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
    if ('setPixelRatio' in this.renderer) {
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    }
  };

  private seedAgents() {
    this.agents.spawn('enemy-grunt', new THREE.Vector3(8, 1.8, 8));
    this.agents.spawn('enemy-grunt', new THREE.Vector3(-8, 1.8, -8));
    this.agents.spawn('enemy-sniper', new THREE.Vector3(12, 1.8, 4));
    this.agents.spawn('enemy-tank', new THREE.Vector3(-6, 1.8, 10));
    this.agents.spawn('enemy-drone', new THREE.Vector3(0, 4, 10));
    this.agents.spawn('enemy-support', new THREE.Vector3(10, 1.8, -6));
    this.agents.spawn('enemy-stealth', new THREE.Vector3(-10, 1.8, 6));
    this.agents.spawn('ally', new THREE.Vector3(2, 1.8, 4));
  }

  private seedPickups() {
    this.pickups.spawn(this.scene, new THREE.Vector3(4, 0.5, 4));
    this.pickups.spawn(this.scene, new THREE.Vector3(-4, 0.5, -4));
    this.pickups.spawn(this.scene, new THREE.Vector3(6, 0.5, -6));
    this.pickups.spawn(this.scene, new THREE.Vector3(-6, 0.5, 6));
    this.pickups.spawn(this.scene, new THREE.Vector3(0, 0.5, 8));
    this.pickups.spawn(this.scene, new THREE.Vector3(0, 0.5, -8));
  }
}
