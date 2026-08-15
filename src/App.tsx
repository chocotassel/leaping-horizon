import { useCallback, useMemo, useState } from 'react';
import { AudioEngine } from './audio/AudioEngine';
import { getLevelForAlgorithm } from './chart';
import { GameScreen } from './components/GameScreen';
import { HomeScreen } from './components/HomeScreen';
import { ResultScreen } from './components/ResultScreen';
import type { GameResult } from './types';

type Screen = 'home' | 'game' | 'result';

export default function App() {
  const [algorithmId] = useState(() => new URLSearchParams(window.location.search).get('algorithm'));
  const level = useMemo(() => getLevelForAlgorithm(algorithmId), [algorithmId]);
  const [screen, setScreen] = useState<Screen>('home');
  const [result, setResult] = useState<GameResult | null>(null);
  const finish = useCallback((nextResult: GameResult) => {
    setResult(nextResult);
    setScreen('result');
  }, []);

  const startGame = useCallback(() => {
    void AudioEngine.unlock();
    setScreen('game');
  }, []);

  return (
    <div className="app-shell">
      <div className="portrait-frame">
        {screen === 'home' && (
          <HomeScreen level={level} onStart={startGame} />
        )}
        {screen === 'game' && <GameScreen level={level} onFinish={finish} />}
        {screen === 'result' && result && (
          <ResultScreen result={result} onReplay={startGame} onHome={() => setScreen('home')} />
        )}
      </div>
    </div>
  );
}
