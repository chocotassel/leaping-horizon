import { useCallback, useMemo, useState, type MouseEvent as ReactMouseEvent } from 'react';
import buttonTapUrl from './assets/audio/ui-button-tap.mp3?base64';
import soundOffUrl from './assets/audio/ui-sound-off.mp3?base64';
import soundOnUrl from './assets/audio/ui-sound-on.mp3?base64';
import { AudioEngine } from './audio/AudioEngine';
import { DEFAULT_LEVEL_ID, LEVELS, getLevelById } from './chart';
import { GameScreen } from './components/GameScreen';
import { HomeScreen } from './components/HomeScreen';
import {
  getResultPresentation,
  ResultScreen,
  type ResultOutcome,
} from './components/ResultScreen';
import { StartScreen } from './components/StartScreen';
import { gameDataManager, recordLevelResult } from './data/localData';
import { getEarnedStars } from './game/stars';
import type { GameResult } from './types';

type Screen = 'start' | 'home' | 'game' | 'result';

function playSound(audioData: string): void {
  void AudioEngine.unlock().then(() => AudioEngine.playEffect(audioData));
}

export default function App() {
  const [levelId, setLevelId] = useState(DEFAULT_LEVEL_ID);
  const level = useMemo(() => getLevelById(levelId), [levelId]);
  const [screen, setScreen] = useState<Screen>('start');
  const [soundEnabled, setSoundEnabled] = useState(false);
  const [gameData, setGameData] = useState(() => gameDataManager.read());
  const [result, setResult] = useState<GameResult | null>(null);
  const [resultStars, setResultStars] = useState(0);
  const [resultOutcome, setResultOutcome] = useState<ResultOutcome>('complete');

  const showResult = useCallback((nextResult: GameResult, outcome: ResultOutcome) => {
    const stars = getEarnedStars(nextResult, outcome === 'complete');
    const nextGameData = recordLevelResult(gameData, level.id, nextResult, stars);
    gameDataManager.write(nextGameData);
    setGameData(nextGameData);
    setResult(nextResult);
    setResultStars(stars);
    setResultOutcome(outcome);
    setScreen('result');
  }, [gameData, level.id]);

  const finish = useCallback((nextResult: GameResult) => {
    showResult(nextResult, 'complete');
  }, [showResult]);

  const crash = useCallback((nextResult: GameResult) => {
    showResult(nextResult, 'crashed');
  }, [showResult]);

  const toggleSound = useCallback(() => {
    setSoundEnabled((enabled) => {
      const next = !enabled;
      playSound(next ? soundOnUrl : soundOffUrl);
      AudioEngine.setMusicEnabled(next);
      if (next && screen !== 'game') void AudioEngine.unlock();
      return next;
    });
  }, [screen]);

  const playButtonTap = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (
      soundEnabled &&
      event.target instanceof Element &&
      event.target.closest('button:not([aria-pressed])')
    ) playSound(buttonTapUrl);
  }, [soundEnabled]);

  const startGame = useCallback(() => {
    void AudioEngine.unlock();
    setScreen('game');
  }, []);

  const prepareGame = useCallback(() => {
    void AudioEngine.unlock();
  }, []);

  return (
    <div className="app-shell">
      <div className="portrait-frame" onClickCapture={playButtonTap}>
        {screen === 'start' && (
          <StartScreen
            soundEnabled={soundEnabled}
            onToggleSound={toggleSound}
            onEnter={() => setScreen('home')}
          />
        )}
        {screen === 'home' && (
          <HomeScreen
            level={level}
            levels={LEVELS}
            gameData={gameData}
            soundEnabled={soundEnabled}
            onPrepareStart={prepareGame}
            onSelectLevel={setLevelId}
            onToggleSound={toggleSound}
            onStart={() => setScreen('game')}
          />
        )}
        {screen === 'game' && (
          <GameScreen
            level={level}
            soundEnabled={soundEnabled}
            onDeath={crash}
            onExit={() => setScreen('home')}
            onFinish={finish}
            onToggleSound={toggleSound}
          />
        )}
        {screen === 'result' && result && (
          <ResultScreen
            result={result}
            stars={resultStars}
            level={level}
            presentation={getResultPresentation(resultOutcome)}
            onReplay={startGame}
            onHome={() => setScreen('home')}
          />
        )}
      </div>
    </div>
  );
}
