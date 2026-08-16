param(
  [string]$PythonCommand = "python"
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$EnvironmentPath = Join-Path $ProjectRoot ".venv-analysis"
$EnvironmentPython = Join-Path $EnvironmentPath "Scripts/python.exe"

& $PythonCommand -m venv $EnvironmentPath
& $EnvironmentPython -m pip install --upgrade pip
& $EnvironmentPython -m pip install `
  "setuptools<81" `
  "librosa==0.11.0" `
  "scikit-learn==1.7.1" `
  "beat-this==1.1.0" `
  "onnxruntime==1.28.0" `
  "mir_eval==0.8.2" `
  "pretty_midi==0.2.11.post0" `
  "resampy==0.4.2"
& $EnvironmentPython -m pip install "basic-pitch==0.4.0" --no-deps

Write-Host 'Rhythm environment is ready. Run: npm run generate -- "path/to/song.wav" ["Title"] ["Artist"] [song-id]'
