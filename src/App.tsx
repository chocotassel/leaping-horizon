import { useCallback, useMemo, useState } from 'react';
import { AudioEngine } from './audio/AudioEngine';
import { DEFAULT_LEVEL_ID, LEVELS, getLevelById } from './chart';
import { GameScreen } from './components/GameScreen';
import { HomeScreen } from './components/HomeScreen';
import { ResultScreen, type ResultOutcome } from './components/ResultScreen';
import { StartScreen } from './components/StartScreen';
import type { GameResult } from './types';

type Screen = 'start' | 'home' | 'game' | 'result';

export default function App() {
  const [levelId, setLevelId] = useState(DEFAULT_LEVEL_ID);
  const level = useMemo(() => getLevelById(levelId), [levelId]);
  const [screen, setScreen] = useState<Screen>('start');
  const [musicEnabled, setMusicEnabled] = useState(false);
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

  const toggleMusic = useCallback(() => {
    setMusicEnabled((enabled) => {
      const next = !enabled;
      AudioEngine.setMusicEnabled(next);
      if (next) void AudioEngine.unlock();
      return next;
    });
  }, []);

  const startGame = useCallback(() => {
    void AudioEngine.unlock();
    setScreen('game');
  }, []);

  return (
    <div className="app-shell">
      <div className="portrait-frame">
        {screen === 'start' && (
          <StartScreen
            musicEnabled={musicEnabled}
            onToggleMusic={toggleMusic}
            onEnter={() => setScreen('home')}
          />
        )}
        {screen === 'home' && (
          <HomeScreen
            level={level}
            levels={LEVELS}
            musicEnabled={musicEnabled}
            onSelectLevel={setLevelId}
            onToggleMusic={toggleMusic}
            onStart={startGame}
          />
        )}
        {screen === 'game' && <GameScreen level={level} onDeath={crash} onFinish={finish} />}
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
