import './style.css';
import { Game } from './game/Game';

const app = document.querySelector<HTMLElement>('#app');
if (!app) throw new Error('#app root not found');

new Game(app);
