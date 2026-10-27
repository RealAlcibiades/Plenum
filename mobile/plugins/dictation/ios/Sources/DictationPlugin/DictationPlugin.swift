import Foundation
import AVFoundation
import Capacitor
import Speech

/// On-device dictation for the Plenum iPhone app (mob-13, MOBILE-UI 8.5.4 and 15.6).
///
/// Recognition runs on the phone first: SFSpeechRecognizer with requiresOnDeviceRecognition. Apple's server recognition
/// is used only when the person has turned on "Allow that" in Phone settings, which arrives as allowServer. The text goes
/// to the shell as partial and final events, and nothing is sent to the computer until the person presses Send.
///
/// Events: partial { text }, final { text }, level { value 0..1 }, end { reason }, error { code, message }.
/// The deployment target is iOS 16; the audio-session permission check uses AVAudioApplication on iOS 17 and later.
@objc(DictationPlugin)
public class DictationPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "DictationPlugin"
    public let jsName = "Dictation"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "available", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestPermission", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancel", returnType: CAPPluginReturnPromise)
    ]

    private let engine = AVAudioEngine()
    private var recognizer: SFSpeechRecognizer?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var listening = false
    private var silenceMs = 2000
    private var lastText = ""
    private var pendingReason: String?
    private var silenceWork: DispatchWorkItem?

    @objc func available(_ call: CAPPluginCall) {
        let probe = SFSpeechRecognizer()
        call.resolve([
            "available": probe?.isAvailable ?? false,
            "onDevice": probe?.supportsOnDeviceRecognition ?? false,
            "serverAvailable": probe?.isAvailable ?? false,
            "permission": permissionState(),
            "platform": "ios"
        ])
    }

    @objc func requestPermission(_ call: CAPPluginCall) {
        SFSpeechRecognizer.requestAuthorization { [weak self] _ in
            self?.requestMicrophone { _ in
                call.resolve(["permission": self?.permissionState() ?? "denied"])
            }
        }
    }

    @objc func start(_ call: CAPPluginCall) {
        if listening {
            call.reject("Dictation is already listening.", "busy")
            return
        }
        guard permissionState() == "granted" else {
            call.reject("Plenum cannot use the microphone. Allow it in Settings › Plenum.", "permission-denied")
            return
        }
        let allowServer = call.getBool("allowServer", false)
        let requested = call.getInt("silenceMs", 2000)
        let silence = min(5000, max(500, requested))
        let locale = call.getString("locale").map { Locale(identifier: $0) } ?? Locale.current
        guard let speech = SFSpeechRecognizer(locale: locale), speech.isAvailable else {
            emit("error", ["code": "locale-unavailable", "message": "Speech recognition is not available for this language."])
            call.reject("Speech recognition is not available for this language.", "locale-unavailable")
            return
        }
        if !allowServer && !speech.supportsOnDeviceRecognition {
            emit("error", ["code": "on-device-unavailable", "message": "On-device recognition is not on this phone for this language."])
            call.reject("On-device recognition is not on this phone for this language.", "on-device-unavailable")
            return
        }
        do {
            try begin(recognizer: speech, allowServer: allowServer, silenceMs: silence)
            call.resolve()
        } catch {
            emit("error", ["code": "unknown", "message": "Dictation could not start."])
            call.reject("Dictation could not start.", "unknown")
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        stopListening(reason: "done")
        call.resolve()
    }

    @objc func cancel(_ call: CAPPluginCall) {
        if listening {
            task?.cancel()
            finish(reason: "cancelled")
        }
        call.resolve()
    }

    private func begin(recognizer speech: SFSpeechRecognizer, allowServer: Bool, silenceMs: Int) throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.record, mode: .measurement, options: .duckOthers)
        try session.setActive(true, options: .notifyOthersOnDeactivation)

        let recognitionRequest = SFSpeechAudioBufferRecognitionRequest()
        recognitionRequest.shouldReportPartialResults = true
        recognitionRequest.requiresOnDeviceRecognition = !allowServer
        if #available(iOS 16.0, *) {
            recognitionRequest.addsPunctuation = true
        }

        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
            self?.request?.append(buffer)
            self?.reportLevel(buffer)
        }
        engine.prepare()
        try engine.start()

        recognizer = speech
        request = recognitionRequest
        self.silenceMs = silenceMs
        lastText = ""
        pendingReason = nil
        listening = true

        task = speech.recognitionTask(with: recognitionRequest) { [weak self] result, error in
            guard let self = self, self.listening else { return }
            if let result = result {
                let text = result.bestTranscription.formattedString
                self.lastText = text
                if result.isFinal {
                    self.emit("final", ["text": text])
                    self.finish(reason: self.pendingReason ?? "done")
                    return
                }
                self.emit("partial", ["text": text])
                self.armSilence()
            }
            if let error = error {
                self.handle(error: error)
            }
        }
        armSilence()
    }

    // Ends the audio, then waits for the recogniser's final result. A safety timer ends the session if it never comes.
    private func stopListening(reason: String) {
        guard listening else { return }
        pendingReason = reason
        silenceWork?.cancel()
        engine.inputNode.removeTap(onBus: 0)
        if engine.isRunning { engine.stop() }
        request?.endAudio()
        DispatchQueue.main.asyncAfter(deadline: .now() + .seconds(3)) { [weak self] in
            guard let self = self, self.listening else { return }
            self.finish(reason: reason)
        }
    }

    private func armSilence() {
        silenceWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self = self else { return }
            self.stopListening(reason: self.lastText.isEmpty ? "no-speech" : "silence")
        }
        silenceWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(silenceMs), execute: work)
    }

    private func handle(error: Error) {
        let nsError = error as NSError
        // Code 1110 is "no speech detected". Any other error ends the session with an error event.
        if nsError.domain == "kAFAssistantErrorDomain" && nsError.code == 1110 {
            finish(reason: "no-speech")
        } else if listening {
            emit("error", ["code": "unknown", "message": "Dictation stopped (recognizer error \(nsError.code))."])
            finish(reason: "error")
        }
    }

    private func finish(reason: String) {
        guard listening else { return }
        listening = false
        silenceWork?.cancel()
        silenceWork = nil
        engine.inputNode.removeTap(onBus: 0)
        if engine.isRunning { engine.stop() }
        request = nil
        task = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        emit("end", ["reason": reason])
    }

    private func reportLevel(_ buffer: AVAudioPCMBuffer) {
        guard let samples = buffer.floatChannelData?[0] else { return }
        let count = Int(buffer.frameLength)
        if count == 0 { return }
        var sum: Float = 0
        for index in 0..<count {
            sum += samples[index] * samples[index]
        }
        let rms = sqrt(sum / Float(count))
        let decibels = 20 * log10(max(rms, 0.000001))
        let level = min(1, max(0, Double((decibels + 60) / 60)))
        DispatchQueue.main.async { [weak self] in
            self?.emit("level", ["value": level])
        }
    }

    private func emit(_ event: String, _ data: [String: Any]) {
        DispatchQueue.main.async { [weak self] in
            self?.notifyListeners(event, data: data, retainUntilConsumed: event == "end" || event == "error")
        }
    }

    private func permissionState() -> String {
        let speech = SFSpeechRecognizer.authorizationStatus()
        var microphone = "prompt"
        if #available(iOS 17.0, *) {
            switch AVAudioApplication.shared.recordPermission {
            case .granted: microphone = "granted"
            case .denied: microphone = "denied"
            default: microphone = "prompt"
            }
        } else {
            switch AVAudioSession.sharedInstance().recordPermission {
            case .granted: microphone = "granted"
            case .denied: microphone = "denied"
            default: microphone = "prompt"
            }
        }
        if speech == .denied || speech == .restricted || microphone == "denied" {
            return "denied"
        }
        return speech == .authorized && microphone == "granted" ? "granted" : "prompt"
    }

    private func requestMicrophone(_ done: @escaping (Bool) -> Void) {
        if #available(iOS 17.0, *) {
            AVAudioApplication.requestRecordPermission(completionHandler: done)
        } else {
            AVAudioSession.sharedInstance().requestRecordPermission(done)
        }
    }
}
