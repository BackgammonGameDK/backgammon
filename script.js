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
