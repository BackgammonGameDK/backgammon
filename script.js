const board = document.querySelector('.board');
let selectedChecker = null;
let currentPlayer = 'white';

function selectChecker(checker) {
  if (selectedChecker) {
    selectedChecker.classList.remove('selected');
  }
  selectedChecker = checker;
  selectedChecker.classList.add('selected');
}

function deselect() {
  if (selectedChecker) {
    selectedChecker.classList.remove('selected');
    selectedChecker = null;
  }
}

board.addEventListener('click', (event) => {
  const point = event.target.closest('.point');

  if (!point) {
    deselect();
    return;
  }

  if (selectedChecker && point !== selectedChecker.parentElement) {
    attemptMove(selectedChecker, point);
    return;
  }

  const checker = event.target.closest('.checker');
  if (checker) {
    if (checker === selectedChecker) {
      deselect();
    } else if (checker.classList.contains(currentPlayer) && diceContainer.children.length > 0) {
      selectChecker(checker);
    }
    return;
  }

  deselect();
});

function isValidMove(checker, fromPoint, toPoint) {
  const color = checker.classList.contains('white') ? 'white' : 'black';
  const opposingColor = color === 'white' ? 'black' : 'white';
  const fromNum = Number(fromPoint.dataset.point);
  const toNum = Number(toPoint.dataset.point);

  const movingForward = color === 'white' ? toNum < fromNum : toNum > fromNum;
  if (!movingForward) {
    return { legal: false };
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

function attemptMove(checker, toPoint) {
  const fromPoint = checker.parentElement;
  const distance = Math.abs(Number(toPoint.dataset.point) - Number(fromPoint.dataset.point));
  const die = findMatchingDie(distance);
  const { legal, hitChecker } = isValidMove(checker, fromPoint, toPoint);

  if (!legal || !die) {
    flashInvalid(toPoint);
    return;
  }

  if (hitChecker) {
    toPoint.closest('.board-row').querySelector('.bar-checkers').appendChild(hitChecker);
  }

  toPoint.appendChild(checker);
  die.classList.add('used');
  deselect();
  checkDiceAvailability();
}

const diceContainer = document.querySelector('#dice');
const rollButton = document.querySelector('#roll-button');
const turnIndicator = document.querySelector('#turn-indicator');
const messageEl = document.querySelector('#message');

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
  return [...diceContainer.querySelectorAll('.die:not(.used)')];
}

function findMatchingDie(distance) {
  return getAvailableDice().find((die) => Number(die.dataset.value) === distance) || null;
}

function canUseDie(value) {
  return [...board.querySelectorAll(`.checker.${currentPlayer}`)].some((checker) => {
    const fromPoint = checker.parentElement;
    if (!fromPoint.classList.contains('point')) {
      return false;
    }
    const fromNum = Number(fromPoint.dataset.point);
    const toNum = currentPlayer === 'white' ? fromNum - value : fromNum + value;
    const toPoint = document.querySelector(`.point[data-point="${toNum}"]`);
    return toPoint ? isValidMove(checker, fromPoint, toPoint).legal : false;
  });
}

function checkDiceAvailability() {
  const forfeited = [];

  getAvailableDice().forEach((die) => {
    if (!canUseDie(Number(die.dataset.value))) {
      die.classList.add('used');
      forfeited.push(die.dataset.value);
    }
  });

  if (forfeited.length > 0) {
    showMessage(`No legal move for ${forfeited.join(', ')} — skipped.`);
  }

  if (getAvailableDice().length === 0) {
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
