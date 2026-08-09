const board = document.querySelector('.board');
let selectedChecker = null;
let currentPlayer = 'white';
let gameOver = false;

function selectChecker(checker) {
  if (selectedChecker) {
    selectedChecker.classList.remove('selected');
  }
  selectedChecker = checker;
  selectedChecker.classList.add('selected');
  highlightLegalTargets(checker);
}

function deselect() {
  if (selectedChecker) {
    selectedChecker.classList.remove('selected');
    selectedChecker = null;
  }
  clearLegalTargets();
}

board.addEventListener('click', (event) => {
  if (gameOver) {
    return;
  }

  const checker = event.target.closest('.checker');
  const point = event.target.closest('.point');
  const offTray = event.target.closest('.off');

  if (selectedChecker && offTray && offTray.dataset.owner === colorOf(selectedChecker) && isHomeReady(colorOf(selectedChecker))) {
    attemptBearOff(selectedChecker, offTray);
    return;
  }

  if (selectedChecker && point && point !== selectedChecker.parentElement) {
    attemptMove(selectedChecker, point);
    return;
  }

  if (checker) {
    const barCheckers = getBarCheckers(currentPlayer);
    const mustClearBarFirst = barCheckers.length > 0 && !isOnBar(checker);
    if (checker === selectedChecker) {
      deselect();
    } else if (
      checker.classList.contains(currentPlayer) &&
      diceContainer.children.length > 0 &&
      !mustClearBarFirst &&
      getLegalDestinations(checker).length > 0
    ) {
      selectChecker(checker);
    }
    return;
  }

  deselect();
});

function isOnBar(checker) {
  return checker.parentElement.classList.contains('bar-checkers');
}

function colorOf(checker) {
  return checker.classList.contains('white') ? 'white' : 'black';
}

function getBarCheckers(color) {
  return [...document.querySelectorAll(`.bar-checkers .checker.${color}`)];
}

function entryPoint(color, dieValue) {
  return color === 'white' ? 25 - dieValue : dieValue;
}

function checkersInPlay(color) {
  return [...document.querySelectorAll(`.point .checker.${color}`)];
}

function pipsFromOff(color, pointNumber) {
  return color === 'white' ? pointNumber : 25 - pointNumber;
}

function pipCount(color) {
  const inPlay = checkersInPlay(color).reduce(
    (sum, c) => sum + pipsFromOff(color, Number(c.parentElement.dataset.point)),
    0
  );
  return inPlay + getBarCheckers(color).length * 25;
}

function isHomeReady(color) {
  if (getBarCheckers(color).length > 0) {
    return false;
  }
  return checkersInPlay(color).every((checker) => {
    const n = Number(checker.parentElement.dataset.point);
    return color === 'white' ? n <= 6 : n >= 19;
  });
}

function isFarthestCheckerPips(color, pips) {
  return !checkersInPlay(color).some((c) => pipsFromOff(color, Number(c.parentElement.dataset.point)) > pips);
}

function findBearOffDie(checker) {
  const color = colorOf(checker);
  const pips = pipsFromOff(color, Number(checker.parentElement.dataset.point));

  const exact = getAvailableDice().find((d) => Number(d.dataset.value) === pips);
  if (exact) {
    return exact;
  }

  if (!isFarthestCheckerPips(color, pips)) {
    return null;
  }
  return getAvailableDice().find((d) => Number(d.dataset.value) > pips) || null;
}

function canBearOffWithValue(color, value) {
  if (!isHomeReady(color)) {
    return false;
  }
  return checkersInPlay(color).some((checker) => {
    const pips = pipsFromOff(color, Number(checker.parentElement.dataset.point));
    return pips === value || (value > pips && isFarthestCheckerPips(color, pips));
  });
}

function getLegalDestinations(checker) {
  const color = colorOf(checker);
  const destinations = new Set();

  if (isOnBar(checker)) {
    getAvailableDice().forEach((die) => {
      const toPoint = document.querySelector(`.point[data-point="${entryPoint(color, Number(die.dataset.value))}"]`);
      if (toPoint && isValidMove(checker, checker.parentElement, toPoint).legal) {
        destinations.add(toPoint);
      }
    });
    return [...destinations];
  }

  const fromNum = Number(checker.parentElement.dataset.point);
  getAvailableDice().forEach((die) => {
    const value = Number(die.dataset.value);
    const toNum = color === 'white' ? fromNum - value : fromNum + value;
    const toPoint = document.querySelector(`.point[data-point="${toNum}"]`);
    if (toPoint && isValidMove(checker, checker.parentElement, toPoint).legal) {
      destinations.add(toPoint);
    }
  });

  if (isHomeReady(color) && findBearOffDie(checker)) {
    destinations.add(document.querySelector(`.off[data-owner="${color}"]`));
  }

  return [...destinations];
}

function isValidMove(checker, fromPoint, toPoint) {
  const color = colorOf(checker);
  const opposingColor = color === 'white' ? 'black' : 'white';
  const toNum = Number(toPoint.dataset.point);

  if (fromPoint.classList.contains('point')) {
    const fromNum = Number(fromPoint.dataset.point);
    const movingForward = color === 'white' ? toNum < fromNum : toNum > fromNum;
    if (!movingForward) {
      return { legal: false };
    }
  }

  const opposingCount = toPoint.querySelectorAll(`.checker.${opposingColor}`).length;
  if (opposingCount >= 2) {
    return { legal: false };
  }

  return {
    legal: true,
    hitChecker: opposingCount === 1 ? toPoint.querySelector(`.checker.${opposingColor}`) : null,
  };
}

function flashInvalid(point) {
  point.classList.add('invalid-target');
  setTimeout(() => point.classList.remove('invalid-target'), 300);
}

function animateMove(checker, moveFn) {
  const before = checker.getBoundingClientRect();
  moveFn();
  const after = checker.getBoundingClientRect();
  const dx = before.left - after.left;
  const dy = before.top - after.top;

  if (dx === 0 && dy === 0) {
    return;
  }

  checker.style.transform = `translate(${dx}px, ${dy}px)`;
  requestAnimationFrame(() => {
    checker.classList.add('animating');
    checker.style.transform = '';
  });

  checker.addEventListener(
    'transitionend',
    () => {
      checker.classList.remove('animating');
      checker.style.transform = '';
    },
    { once: true }
  );
}

function attemptMove(checker, toPoint) {
  const fromPoint = checker.parentElement;
  const color = colorOf(checker);
  const toNum = Number(toPoint.dataset.point);

  const die = isOnBar(checker)
    ? getAvailableDice().find((d) => entryPoint(color, Number(d.dataset.value)) === toNum) || null
    : findMatchingDie(Math.abs(toNum - Number(fromPoint.dataset.point)));

  const { legal, hitChecker } = isValidMove(checker, fromPoint, toPoint);

  if (!legal || !die) {
    flashInvalid(toPoint);
    return;
  }

  if (hitChecker) {
    const bar = toPoint.closest('.board-row').querySelector('.bar-checkers');
    animateMove(hitChecker, () => bar.appendChild(hitChecker));
  }

  animateMove(checker, () => toPoint.appendChild(checker));
  die.classList.add('played');
  updatePipCounts();
  deselect();
  checkDiceAvailability();
}

function attemptBearOff(checker, offTray) {
  const die = findBearOffDie(checker);

  if (!die) {
    flashInvalid(offTray);
    return;
  }

  animateMove(checker, () => offTray.querySelector('.off-checkers').appendChild(checker));
  die.classList.add('played');
  updatePipCounts();
  deselect();

  if (isGameWon(colorOf(checker))) {
    endGame(colorOf(checker));
    return;
  }

  checkDiceAvailability();
}

function isGameWon(color) {
  return document.querySelectorAll(`.off[data-owner="${color}"] .checker.${color}`).length === 15;
}

function endGame(color) {
  gameOver = true;
  diceContainer.innerHTML = '';
  rollButton.disabled = true;
  gameOverEl.textContent = `${color === 'white' ? 'White' : 'Black'} wins!`;
}

const diceContainer = document.querySelector('#dice');
const rollButton = document.querySelector('#roll-button');
const restartButton = document.querySelector('#restart-button');
const gameOverEl = document.querySelector('#game-over');
const turnIndicator = document.querySelector('#turn-indicator');
const messageEl = document.querySelector('#message');
const hintsToggle = document.querySelector('#hints-toggle');
const pipCountEl = document.querySelector('#pip-count');

let hintsEnabled = false;

function highlightLegalTargets(checker) {
  if (!hintsEnabled) {
    return;
  }
  getLegalDestinations(checker).forEach((el) => el.classList.add('legal-target'));
}

function updatePipCounts() {
  pipCountEl.textContent = `Pips — White: ${pipCount('white')} · Black: ${pipCount('black')}`;
}

function clearLegalTargets() {
  document.querySelectorAll('.legal-target').forEach((el) => el.classList.remove('legal-target'));
}

function rollDie() {
  return Math.floor(Math.random() * 6) + 1;
}

function createDie(value) {
  const die = document.createElement('div');
  die.className = 'die';
  die.dataset.value = value;
  for (let i = 0; i < 9; i++) {
    die.appendChild(document.createElement('span')).className = 'pip';
  }
  return die;
}

function rollDice() {
  const first = rollDie();
  const second = rollDie();
  const values = first === second ? [first, first, first, first] : [first, second];

  diceContainer.innerHTML = '';
  values.forEach((value) => diceContainer.appendChild(createDie(value)));
  rollButton.disabled = true;
  checkDiceAvailability();
}

function getAvailableDice() {
  return [...diceContainer.querySelectorAll('.die:not(.played)')];
}

function findMatchingDie(distance) {
  return getAvailableDice().find((die) => Number(die.dataset.value) === distance) || null;
}

function canUseDie(value) {
  const barCheckers = getBarCheckers(currentPlayer);
  if (barCheckers.length > 0) {
    const toPoint = document.querySelector(`.point[data-point="${entryPoint(currentPlayer, value)}"]`);
    return isValidMove(barCheckers[0], barCheckers[0].parentElement, toPoint).legal;
  }

  const hasNormalMove = [...board.querySelectorAll(`.checker.${currentPlayer}`)].some((checker) => {
    const fromPoint = checker.parentElement;
    if (!fromPoint.classList.contains('point')) {
      return false;
    }
    const fromNum = Number(fromPoint.dataset.point);
    const toNum = currentPlayer === 'white' ? fromNum - value : fromNum + value;
    const toPoint = document.querySelector(`.point[data-point="${toNum}"]`);
    return toPoint ? isValidMove(checker, fromPoint, toPoint).legal : false;
  });

  return hasNormalMove || canBearOffWithValue(currentPlayer, value);
}

function checkDiceAvailability() {
  const remaining = getAvailableDice();

  if (remaining.length === 0) {
    endTurn();
    return;
  }

  let anyUsable = false;
  remaining.forEach((die) => {
    const usable = canUseDie(Number(die.dataset.value));
    die.classList.toggle('forfeited', !usable);
    if (usable) {
      anyUsable = true;
    }
  });

  if (!anyUsable) {
    showMessage(`No legal move for ${remaining.map((die) => die.dataset.value).join(', ')} — skipped.`);
    endTurn();
  }
}

function endTurn() {
  currentPlayer = currentPlayer === 'white' ? 'black' : 'white';
  diceContainer.innerHTML = '';
  rollButton.disabled = false;
  updateTurnIndicator();
}

function updateTurnIndicator() {
  turnIndicator.textContent = `${currentPlayer === 'white' ? 'White' : 'Black'}'s turn`;
}

function showMessage(text) {
  messageEl.textContent = text;
  setTimeout(() => {
    if (messageEl.textContent === text) {
      messageEl.textContent = '';
    }
  }, 3000);
}

rollButton.addEventListener('click', rollDice);
restartButton.addEventListener('click', () => location.reload());
hintsToggle.addEventListener('change', () => {
  hintsEnabled = hintsToggle.checked;
  pipCountEl.hidden = !hintsEnabled;
  clearLegalTargets();
  if (hintsEnabled && selectedChecker) {
    highlightLegalTargets(selectedChecker);
  }
});

updatePipCounts();
