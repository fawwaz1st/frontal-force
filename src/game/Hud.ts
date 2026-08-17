export function createHud() {
  const root = document.createElement('div');
  root.className = 'hud';
  root.innerHTML = `
    <div class="hud__topbar">
      <div class="hud__title">Frontal Force</div>
      <div class="hud__mode" data-mode>Booting...</div>
    </div>
    <div class="hud__panel hud__panel--grid">
      <div><span>HP</span> <strong data-hp>100</strong></div>
      <div><span>Armor</span> <strong data-armor>50</strong></div>
      <div><span>Ammo</span> <strong data-ammo>30 / 120</strong></div>
      <div><span>Weapon</span> <strong data-weapon>Pistol</strong></div>
      <div><span>Level</span> <strong data-level>1</strong></div>
      <div><span>XP</span> <strong data-xp>0</strong></div>
      <div><span>Mode</span> <strong data-gamemode>Deathmatch</strong></div>
      <div><span>Enemy / Ally</span> <strong data-roster>12 / 1</strong></div>
      <div><span>Skill Points</span> <strong data-skillpoints>0</strong></div>
      <div><span>Input</span> <strong data-input>Mouse locked required</strong></div>
    </div>
    <div class="hud__crosshair"></div>
    <div class="hud__hint">Click to lock pointer. WASD, mouse, Space, Shift, C, E, R, 1-9.</div>
    <div class="hud__chat">
      <textarea data-chat placeholder="AI ally chat / command console"></textarea>
    </div>
  `;

  const mode = root.querySelector<HTMLElement>('[data-mode]')!;
  const hp = root.querySelector<HTMLElement>('[data-hp]')!;
  const armor = root.querySelector<HTMLElement>('[data-armor]')!;
  const ammo = root.querySelector<HTMLElement>('[data-ammo]')!;
  const weapon = root.querySelector<HTMLElement>('[data-weapon]')!;
  const level = root.querySelector<HTMLElement>('[data-level]')!;
  const xp = root.querySelector<HTMLElement>('[data-xp]')!;
  const gamemode = root.querySelector<HTMLElement>('[data-gamemode]')!;
  const roster = root.querySelector<HTMLElement>('[data-roster]')!;
  const skillpoints = root.querySelector<HTMLElement>('[data-skillpoints]')!;
  const input = root.querySelector<HTMLElement>('[data-input]')!;

  return {
    root,
    setStatus(renderMode: string, gameStatus: { hp: number; armor: number; ammo: string; ally: string; currentMode?: string; enemyCount?: number; allyCount?: number }, inputStatus: { locked: boolean }, weaponStatus: string, levelValue: number, xpValue: number, skillPoints = 0) {
      mode.textContent = `Renderer: ${renderMode.toUpperCase()}`;
      hp.textContent = String(gameStatus.hp);
      armor.textContent = String(gameStatus.armor);
      ammo.textContent = gameStatus.ammo;
      weapon.textContent = weaponStatus;
      level.textContent = String(levelValue);
      xp.textContent = String(xpValue);
      gamemode.textContent = gameStatus.currentMode ?? 'Deathmatch';
      roster.textContent = `${gameStatus.enemyCount ?? 0} / ${gameStatus.allyCount ?? 0}`;
      skillpoints.textContent = String(skillPoints);
      input.textContent = inputStatus.locked ? 'Locked' : 'Click to lock';
    }
  };
}
