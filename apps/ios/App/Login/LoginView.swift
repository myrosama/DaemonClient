import AuthenticationServices
import SwiftUI

struct LoginView: View {
    @Environment(AppModel.self) private var app
    /// Nur vorbelegt – gespeichert wird die Adresse erst nach erfolgreicher Anmeldung (ImmichClient.login)
    @State private var server = UserDefaults.standard.string(forKey: "serverURL") ?? ""
    @State private var email = ""
    @State private var password = ""
    @State private var busy = false
    @State private var error: String?
    /// Anmeldearten des eingegebenen Servers (SSO-Knopf, Passwortfelder) – nil, solange unbekannt
    @State private var options: ImmichClient.LoginOptions?
    @Environment(\.webAuthenticationSession) private var webAuth

    init() {
        #if DEBUG
        // Simulator-Tests: Felder mit „@“ vorbelegen (simctl tippt es mit deutscher Mac-Tastatur als Anführungszeichen)
        let env = ProcessInfo.processInfo.environment
        if let s = env["FOTOS_LOGIN_SERVER"] { _server = State(initialValue: s) }
        if let e = env["FOTOS_LOGIN_EMAIL"] { _email = State(initialValue: e) }
        if let p = env["FOTOS_LOGIN_PASSWORD"] { _password = State(initialValue: p) }
        #endif
    }

    var body: some View {
        ZStack {
            LinearGradient(colors: [Color.loginTop, Color.appBackground], startPoint: .top, endPoint: .bottom)
                .ignoresSafeArea()
            VStack(spacing: 18) {
                Spacer()
                Image(systemName: "photo.on.rectangle.angled")
                    .font(.system(size: 64)).symbolRenderingMode(.multicolor)
                Text(verbatim: "Phosphor Photos").font(.system(size: 40, weight: .bold))
                Text(String(localized: "Deine Mediathek auf deinem eigenen Server")).foregroundStyle(.secondary)
                VStack(spacing: 12) {
                    field(String(localized: "Server, z. B. https://fotos.example.com"), text: $server, icon: "server.rack")
                        .textInputAutocapitalization(.never).keyboardType(.URL).autocorrectionDisabled()
                    if options?.password != false {
                        field(String(localized: "E-Mail"), text: $email, icon: "person")
                            .textInputAutocapitalization(.never).keyboardType(.emailAddress).autocorrectionDisabled()
                        HStack {
                            Image(systemName: "lock").frame(width: 24).foregroundStyle(.secondary)
                            SecureField(String(localized: "Passwort"), text: $password).textContentType(.password)
                        }
                        .padding(.horizontal, 18).frame(height: 54)
                        .glassEffect(.regular, in: .capsule)
                    }
                }
                .padding(.top, 20)
                if let error { Text(error).font(.footnote).foregroundStyle(.red).multilineTextAlignment(.center) }
                if options?.password != false {
                    Button { Task { await login() } } label: {
                        Group { if busy { ProgressView() } else { Text(String(localized: "Anmelden")).font(.headline) } }
                            .frame(maxWidth: .infinity, minHeight: 54)
                    }
                    .buttonStyle(.glassProminent)
                    .disabled(busy || email.isEmpty || password.isEmpty)
                }
                if let o = options, o.sso {
                    // SSO wie in der Immich-App; Knopftext kommt vom Server (z. B. „Login with PixelUnion“).
                    // Ohne Passwort-Anmeldung ist es der Hauptknopf.
                    if o.password {
                        ssoButton(o).buttonStyle(.glass)
                    } else {
                        ssoButton(o).buttonStyle(.glassProminent)
                    }
                }
                Spacer(); Spacer()
            }
            .frame(maxWidth: 520)   // iPad: Formular nicht über die ganze Breite
            .padding(.horizontal, 28)
        }
        // Nach dem Tippen der Adresse kurz warten, dann die Anmeldearten des Servers abfragen
        .task(id: server) {
            options = nil
            guard server.count > 3 else { return }
            try? await Task.sleep(for: .milliseconds(700))
            guard !Task.isCancelled else { return }
            options = try? await ImmichClient.shared.loginOptions(server: server)
        }
    }

    private func ssoButton(_ o: ImmichClient.LoginOptions) -> some View {
        Button { Task { await loginSSO() } } label: {
            Group {
                if busy && !o.password { ProgressView() } else {
                    Label(o.ssoTitle ?? String(localized: "Mit SSO anmelden"), systemImage: "person.badge.key").font(.headline)
                }
            }
            .frame(maxWidth: .infinity, minHeight: 54)
        }
        .disabled(busy)
    }

    private func field(_ title: String, text: Binding<String>, icon: String) -> some View {
        HStack {
            Image(systemName: icon).frame(width: 24).foregroundStyle(.secondary)
            TextField(title, text: text)
        }
        .padding(.horizontal, 18).frame(height: 54)
        .glassEffect(.regular, in: .capsule)
    }

    private func loginSSO() async {
        busy = true; error = nil; defer { busy = false }
        do {
            let flow = try await ImmichClient.shared.ssoStart(server: server)
            let callback = try await webAuth.authenticate(using: flow.url, callbackURLScheme: ImmichClient.ssoScheme,
                                                          preferredBrowserSession: .shared)
            let r = try await ImmichClient.shared.ssoFinish(flow, callback: callback)
            app.userName = r.name
            app.loggedIn = true
        } catch let e as ASWebAuthenticationSessionError where e.code == .canceledLogin {
            // abgebrochen: still zurück zur Anmeldeseite
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func login() async {
        busy = true; error = nil; defer { busy = false }
        do {
            let r = try await ImmichClient.shared.login(server: server, email: email, password: password)
            app.userName = r.name
            app.loggedIn = true
        } catch {
            self.error = error.localizedDescription
        }
    }
}
