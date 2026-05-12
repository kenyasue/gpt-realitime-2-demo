# Generates .test-artifacts/speech.wav from Windows TTS.
# 48 kHz mono 16-bit PCM, with 3 s of trailing silence so VAD can detect end-of-turn between loops.
# Used by scripts/e2e-voice-test.mjs as Chromium's --use-file-for-fake-audio-capture source.

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech

$root = Split-Path $PSScriptRoot -Parent
$base = Join-Path $root '.test-artifacts'
if (-not (Test-Path $base)) { New-Item -ItemType Directory -Force $base | Out-Null }

$tmp = Join-Path $base 'speech.raw.wav'
$out = Join-Path $base 'speech.wav'

$rate = 48000
$info = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo($rate,
    [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,
    [System.Speech.AudioFormat.AudioChannel]::Mono)
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$s.SetOutputToWaveFile($tmp, $info)
$s.Speak('Hello! Please say a short friendly greeting back to me.')
$s.Dispose()

$bytes = [System.IO.File]::ReadAllBytes($tmp)
$header = New-Object byte[] 44
[Array]::Copy($bytes, 0, $header, 0, 44)
$audio = New-Object byte[] ($bytes.Length - 44)
[Array]::Copy($bytes, 44, $audio, 0, $audio.Length)

$silenceBytes = $rate * 2 * 3
$silence = New-Object byte[] $silenceBytes

$newDataSize = $audio.Length + $silenceBytes
$newRiffSize = 36 + $newDataSize
$riffBytes = [System.BitConverter]::GetBytes([uint32]$newRiffSize)
$dataBytes = [System.BitConverter]::GetBytes([uint32]$newDataSize)
[Array]::Copy($riffBytes, 0, $header, 4, 4)
[Array]::Copy($dataBytes, 0, $header, 40, 4)

$fs = [System.IO.File]::Create($out)
$fs.Write($header, 0, 44)
$fs.Write($audio, 0, $audio.Length)
$fs.Write($silence, 0, $silenceBytes)
$fs.Close()
Remove-Item $tmp -ErrorAction SilentlyContinue

$len = (Get-Item $out).Length
Write-Output "Wrote $out ($len bytes)"
