import { useCallback, useMemo, useState, type MouseEvent as ReactMouseEvent } from 'react';
import buttonTapUrl from './assets/audio/ui-button-tap.mp3';
import soundOffUrl from './assets/audio/ui-sound-off.mp3';
import soundOnUrl from './assets/audio/ui-sound-on.mp3';
import { AudioEngine } from './audio/AudioEngine';
import { DEFAULT_LEVEL_ID, LEVELS, getLevelById } from './chart';
import { GameScreen } from './components/GameScreen';
import { HomeScreen } from './components/HomeScreen';
import { ResultScreen, type ResultOutcome } from './components/ResultScreen';
import { StartScreen } from './components/StartScreen';
import type { GameResult } from './types';

type Screen = 'start' | 'home' | 'game' | 'result';

function playSound(url: string): void {
  void new Audio(url).play().catch(() => {});
}

export default function App() {
  const [levelId, setLevelId] = useState(DEFAULT_LEVEL_ID);
  const level = useMemo(() => getLevelById(levelId), [levelId]);
  const [screen, setScreen] = useState<Screen>('start');
  const [soundEnabled, setSoundEnabled] = useState(false);
  const [result, setResult] = useState<GameResult | null>(null);
  const [resultOutcome, setResultOutcome] = useState<ResultOutcome>('complete');
  const finish = useCallback((nextResult: GameResult) => {
    setResult(nextResult);
    setResultOutcome('complete');
    setScreen('result');
  }, []);

  const crash = useCallback((nextResult: GameResult) => {
    setResult(nextResult);
    setResultOutcome('crashed');
    setScreen('result');
  }, []);

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
            level={level}
            outcome={resultOutcome}
            onReplay={startGame}
            onHome={() => setScreen('home')}
          />
        )}
      </div>
    </div>
  );
}
