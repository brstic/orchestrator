// Panels are code-split: a panel's module is downloaded and evaluated the first time that panel
// (or another panel living in the same file) is opened, not when the office starts. Each module
// still registers its panels itself (`registerPanel`) when it loads; this file only says which
// module holds which panel. It is imported once, after the registry (index.tsx) has been evaluated.
//
// The menu does not depend on any of this: it lists every panel from the start, and opening one
// loads it. Only the small question/approval window is part of the main bundle (index.tsx),
// because it has to appear the instant an employee needs an answer.
import { registerLazyPanels } from './index.tsx';
// The panels' two small stylesheets stay in the main bundle, at the place in the cascade they
// have always had (before styles.css): loaded late with a chunk they would win ties they used to lose.
import './panels-work.css';
import './panels-company.css';

registerLazyPanels(['tasks', 'task'], () => import('./tasks.tsx'));
registerLazyPanels(['projects'], () => import('./projects.tsx'));
registerLazyPanels(['meetings'], () => import('./meetings.tsx'));
registerLazyPanels(['growth'], () => import('./growth.tsx'));
registerLazyPanels(['team', 'employee'], () => import('./team.tsx'));
registerLazyPanels(['hosts'], () => import('./hosts.tsx'));
registerLazyPanels(['wall'], () => import('./wall.tsx'));
// The CEO desk is the Company window.
registerLazyPanels(['overview', 'ceo'], () => import('./overview.tsx'));
registerLazyPanels(['map'], () => import('./map.tsx'));
registerLazyPanels(['notifications'], () => import('./notifications.tsx'));
registerLazyPanels(['settings'], () => import('./settings.tsx'));
registerLazyPanels(['help'], () => import('./help.tsx'));
registerLazyPanels(['office'], () => import('./office.tsx'));
registerLazyPanels(['talk'], () => import('./talk.tsx'));
registerLazyPanels(['docs'], () => import('./docs.tsx'));
registerLazyPanels(['radio'], () => import('./radio.tsx'));
registerLazyPanels(['reports'], () => import('./reports.tsx'));
registerLazyPanels(['seat'], () => import('./seat.tsx'));
registerLazyPanels(['people'], () => import('./people.tsx'));
registerLazyPanels(['myroom'], () => import('./my-room.tsx'));
registerLazyPanels(['vault'], () => import('./vault.tsx'));
