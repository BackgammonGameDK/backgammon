const board = document.querySelector('.board');
let selectedChecker = null;

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
    } else {
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
  const { legal, hitChecker } = isValidMove(checker, fromPoint, toPoint);

  if (!legal) {
    flashInvalid(toPoint);
    return;
  }

  if (hitChecker) {
    toPoint.closest('.board-row').querySelector('.bar-checkers').appendChild(hitChecker);
  }

  toPoint.appendChild(checker);
  deselect();
}

const diceContainer = document.querySelector('#dice');
const rollButton = document.querySelector('#roll-button');

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
}

rollButton.addEventListener('click', rollDice);
