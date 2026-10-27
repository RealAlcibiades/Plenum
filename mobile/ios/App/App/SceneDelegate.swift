import UIKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    // Privacy screen (MOBILE-UI 15.6 and 6.13). When the scene resigns active, the app-switcher
    // snapshot shows only the Plenum mark on the page background (--bg: #f6f6fb in light,
    // #0a0a11 in dark), so no prompt, reply or file name is captured. The shield is removed
    // when the scene becomes active again. It is always on for iOS: iOS has no screenshot
    // flag, so the Android-only setting does not apply here.
    private static let shieldTag = 0x504C4E53

    private static let pageBackground = UIColor { traits in
        if traits.userInterfaceStyle == .dark {
            return UIColor(red: 10.0 / 255.0, green: 10.0 / 255.0, blue: 17.0 / 255.0, alpha: 1)
        }
        return UIColor(red: 246.0 / 255.0, green: 246.0 / 255.0, blue: 251.0 / 255.0, alpha: 1)
    }

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = CAPBridgeViewController()
        window?.makeKeyAndVisible()

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func sceneWillResignActive(_ scene: UIScene) {
        guard let host = window ?? (scene as? UIWindowScene)?.windows.first else { return }
        if host.viewWithTag(SceneDelegate.shieldTag) != nil { return }

        let shield = UIView(frame: host.bounds)
        shield.tag = SceneDelegate.shieldTag
        shield.backgroundColor = SceneDelegate.pageBackground
        shield.autoresizingMask = [.flexibleWidth, .flexibleHeight]

        let mark = UIImageView(image: UIImage(named: "PlenumMark"))
        mark.contentMode = .scaleAspectFit
        mark.translatesAutoresizingMaskIntoConstraints = false
        shield.addSubview(mark)
        NSLayoutConstraint.activate([
            mark.centerXAnchor.constraint(equalTo: shield.centerXAnchor),
            mark.centerYAnchor.constraint(equalTo: shield.centerYAnchor),
            mark.widthAnchor.constraint(equalToConstant: 120),
            mark.heightAnchor.constraint(equalToConstant: 120)
        ])

        host.addSubview(shield)
    }

    func sceneDidBecomeActive(_ scene: UIScene) {
        window?.viewWithTag(SceneDelegate.shieldTag)?.removeFromSuperview()
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}
