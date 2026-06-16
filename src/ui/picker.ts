import { fetchProjects } from '../api';
import { el } from './dom';

/* Start screen shown at / with no ?project= param. Lists every registered
   project; picking one navigates to ?project=<id>, which reloads and boots the
   studio on that project. */
export async function showPicker(): Promise<void> {
  document.title = 'Kinema';
  const app = document.getElementById('app')!;

  const list = el('div', { class: 'pick-list' });
  const screen = el('div', { class: 'picker' },
    el('h1', { text: 'Kinema' }),
    el('p', { class: 'pick-sub', text: 'pick a project' }),
    list,
  );
  app.append(screen);

  let projects;
  try {
    projects = await fetchProjects();
  } catch (e) {
    list.append(el('p', { class: 'pick-empty', text: `could not load projects: ${e}` }));
    return;
  }

  if (!projects.length) {
    list.append(el('p', { class: 'pick-empty', text: 'no projects found. add one under projects/ or via studio.config.json.' }));
    return;
  }

  for (const proj of projects) {
    const card = el('button', { class: 'pick-card' },
      el('span', { class: 'pick-name', text: proj.name }),
      el('span', { class: 'pick-path', text: proj.path }),
    );
    if (proj.default) card.append(el('span', { class: 'pick-badge', text: 'default' }));
    card.onclick = () => openProject(proj.id);
    list.append(card);
  }
}

/* navigate to a project: sets ?project=<id> and reloads (we don't hot-swap the
   Player/Timeline; a full reload is simplest given how much hangs off a project) */
export function openProject(id: string): void {
  const params = new URLSearchParams(location.search);
  params.set('project', id);
  location.search = params.toString();
}
