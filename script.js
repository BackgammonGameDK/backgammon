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
    point.appendChild(selectedChecker);
    deselect();
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
