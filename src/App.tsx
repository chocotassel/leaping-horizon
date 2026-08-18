import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
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
import { afterNextPaint } from './game/launchGate';
import { getEarnedStars } from './game/stars';
import type { GameResult } from './types';

type Screen = 'start' | 'home' | 'preparing' | 'game' | 'result';

interface GamePreparation {
  promise: Promise<void>;
  reject: (error: unknown) => void;
  resolve: () => void;
}

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
  const gamePreparationRef = useRef<GamePreparation | null>(null);

  useEffect(() => {
    const recoverAudio = () => {
      if (document.visibilityState === 'visible') void AudioEngine.recover();
    };
    document.addEventListener('visibilitychange', recoverAudio);
    window.addEventListener('pageshow', recoverAudio);
    navigator.mediaDevices?.addEventListener?.('devicechange', recoverAudio);
    return () => {
      document.removeEventListener('visibilitychange', recoverAudio);
      window.removeEventListener('pageshow', recoverAudio);
      navigator.mediaDevices?.removeEventListener?.('devicechange', recoverAudio);
    };
  }, []);

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

  const completeGamePreparation = useCallback(() => {
    const preparation = gamePreparationRef.current;
    if (!preparation) return;
    gamePreparationRef.current = null;
    preparation.resolve();
  }, []);

  const failGamePreparation = useCallback((error: unknown) => {
    const preparation = gamePreparationRef.current;
    if (!preparation) return;
    gamePreparationRef.current = null;
    preparation.reject(error);
    setScreen('home');
  }, []);

  const cancelGamePreparation = useCallback(() => {
    const preparation = gamePreparationRef.current;
    gamePreparationRef.current = null;
    preparation?.reject(new Error('Game preparation cancelled.'));
    setScreen('home');
  }, []);

  const prepareGame = useCallback((): Promise<void> => {
    if (gamePreparationRef.current) return gamePreparationRef.current.promise;
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((resolved, rejected) => {
      resolve = resolved;
      reject = rejected;
    });
    gamePreparationRef.current = { promise, reject, resolve };
    void AudioEngine.unlock().catch(failGamePreparation);
    afterNextPaint(() => {
      if (gamePreparationRef.current?.promise === promise) setScreen('preparing');
    });
    return promise;
  }, [failGamePreparation]);

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
        {(screen === 'preparing' || screen === 'game') && (
          <GameScreen
            key={`game-${level.id}`}
            active={screen === 'game'}
            preparing={screen === 'preparing'}
            level={level}
            soundEnabled={soundEnabled}
            onDeath={crash}
            onExit={() => setScreen('home')}
            onFinish={finish}
            onPrepared={completeGamePreparation}
            onPrepareError={failGamePreparation}
            onToggleSound={toggleSound}
          />
        )}
        {(screen === 'home' || screen === 'preparing') && (
          <HomeScreen
            key="home"
            level={level}
            levels={LEVELS}
            gameData={gameData}
            soundEnabled={soundEnabled}
            onCancelStart={cancelGamePreparation}
            onPrepareStart={prepareGame}
            onSelectLevel={setLevelId}
            onToggleSound={toggleSound}
            onStart={() => setScreen('game')}
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
