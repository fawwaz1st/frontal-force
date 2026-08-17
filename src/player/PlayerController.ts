import * as THREE from 'three';
import { InputSystem, InputSnapshot } from '../game/InputSystem';
import { PhysicsWorld } from '../physics/PhysicsWorld';

export class PlayerController {
  public readonly rig = new THREE.Group();
  public readonly cameraPivot = new THREE.Group();
  public readonly camera = new THREE.PerspectiveCamera(75, 1, 0.1, 1000);
  private velocity = new THREE.Vector3();
  private yaw = 0;
  private pitch = 0;
  private grounded = true;
  private canDash = true;
  private dashing = false;
  private dashTimer = 0;
  private slideTimer = 0;
  private wallJumpCooldown = 0;

  public constructor(private readonly physics: PhysicsWorld) {
    this.cameraPivot.add(this.camera);
    this.rig.add(this.cameraPivot);
    this.camera.position.set(0, 0.15, 0);
  }

  public update(delta: number, input: InputSystem) {
    const snap = input.snapshot();
    this.applyLook(snap);
    this.applyMovement(delta, snap);
    this.dashTimer = Math.max(0, this.dashTimer - delta);
    this.slideTimer = Math.max(0, this.slideTimer - delta);
    this.wallJumpCooldown = Math.max(0, this.wallJumpCooldown - delta);
    const eye = this.rig.position.clone();
    eye.y += 1.8;
    this.camera.position.lerp(eye, delta * 12);
    return eye;
  }

  private applyLook(snap: InputSnapshot) {
    this.yaw -= snap.lookX * 0.0022;
    this.pitch = THREE.MathUtils.clamp(this.pitch - snap.lookY * 0.0022, -1.15, 1.15);
    this.rig.rotation.y = this.yaw;
    this.cameraPivot.rotation.x = this.pitch;
  }

  private applyMovement(delta: number, snap: InputSnapshot) {
    const sprinting = snap.sprint && snap.moveZ > 0;
    const baseSpeed = sprinting ? 9 : snap.crouch ? 3.5 : 6;
    const jumpStrength = this.grounded && snap.jump ? 7.5 : 0;
    const forward = new THREE.Vector3(0, 0, -1).applyAxisAngle(new THREE.Vector3(0, 1, 0), this.yaw);
    const right = new THREE.Vector3(1, 0, 0).applyAxisAngle(new THREE.Vector3(0, 1, 0), this.yaw);
    const move = new THREE.Vector3();
    move.addScaledVector(forward, snap.moveZ * -1);
    move.addScaledVector(right, snap.moveX);
    if (move.lengthSq() > 0) move.normalize();

    let speedMult = 1;
    if (this.slideTimer > 0) speedMult = 1.6;
    else if (snap.crouch && sprinting) { this.slideTimer = 0.6; speedMult = 1.6; }

    if (snap.interact && this.canDash && !this.dashing && move.lengthSq() > 0.01) {
      this.dashing = true;
      this.canDash = false;
      this.dashTimer = 0.8;
      setTimeout(() => { this.dashing = false; setTimeout(() => { this.canDash = true; }, 600); }, 200);
    }

    const dashBoost = this.dashing ? 3 : 1;
    this.velocity.x = move.x * baseSpeed * speedMult * dashBoost;
    this.velocity.z = move.z * baseSpeed * speedMult * dashBoost;

    if (this.grounded || this.wallJumpCooldown <= 0) {
      this.velocity.y = jumpStrength || this.velocity.y - 18 * delta;
    }
    this.rig.position.addScaledVector(this.velocity, delta);
    if (this.rig.position.y <= 1.8) {
      this.rig.position.y = 1.8;
      this.velocity.y = 0;
      this.grounded = true;
    } else {
      this.grounded = false;
    }
  }
}
