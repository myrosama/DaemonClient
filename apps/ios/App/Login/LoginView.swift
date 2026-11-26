import SafariServices
import SwiftUI

/// Sign-in through the core (I4): the Phosphor service by default, a self-hosted server as the second choice (D8).
struct LoginView: View {
    @Environment(AppModel.self) private var app
    @State private var ownServer: Bool
    @State private var server: String
    @State private var email = ""
    @State private var password = ""
    @State private var showPassword = false
    @State private var busy = false
    @State private var error: String?
    @FocusState private var focus: Field?

    private enum Field { case server, email, password }
    private static let hosted = "api.daemonclient.uz"
    private static let signUp = URL(string: "https://accounts.daemonclient.uz/signup")!

    init() {
        // Only to prefill: an address is kept after a successful sign-in.
        var saved = UserDefaults.standard.string(forKey: "serverURL") ?? ""
        var email = ""
        #if DEBUG
        let env = ProcessInfo.processInfo.environment
        if let s = env["FOTOS_LOGIN_SERVER"] { saved = s }
        if let e = env["FOTOS_LOGIN_EMAIL"] { email = e }
        #endif
        let own = !saved.isEmpty && !saved.lowercased().contains(Self.hosted)
        _ownServer = State(initialValue: own)
        _server = State(initialValue: own ? saved : "")
        _email = State(initialValue: email)
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                Image("Logo")
                    .resizable().frame(width: 88, height: 88)
                    .clipShape(.rect(cornerRadius: 20, style: .continuous))
                    .shadow(color: .black.opacity(0.15), radius: 12, y: 4)
                    .accessibilityHidden(true)
                Text(verbatim: "Phosphor Photos")
                    .font(.largeTitle.bold()).padding(.top, 20)
                Text("Sign in to your library")
                    .foregroundStyle(.secondary).padding(.top, 4)

                VStack(alignment: .leading, spacing: 16) {
                    if ownServer {
                        labeled(String(localized: "Server address")) {
                            TextField(String(""), text: $server, prompt: Text(verbatim: "https://photos.example.com"))
                                .keyboardType(.URL).textContentType(.URL)
                                .focused($focus, equals: .server).submitLabel(.next)
                                .onSubmit { focus = .email }
                        }
                    }
                    labeled(String(localized: "E-Mail")) {
                        TextField(String(""), text: $email, prompt: Text(verbatim: "name@example.com"))
                            .keyboardType(.emailAddress).textContentType(.username)
                            .focused($focus, equals: .email).submitLabel(.next)
                            .onSubmit { focus = .password }
                    }
                    labeled(String(localized: "Passwort")) {
                        HStack {
                            Group {
                                if showPassword { TextField(String(""), text: $password) }
                                else { SecureField(String(""), text: $password) }
                            }
                            .textContentType(.password)
                            .focused($focus, equals: .password).submitLabel(.go)
                            .onSubmit { if canSignIn { Task { await signIn() } } }
                            Button { showPassword.toggle() } label: {
                                Image(systemName: showPassword ? "eye.slash" : "eye").foregroundStyle(.secondary)
                            }
                            .accessibilityLabel(showPassword ? String(localized: "Hide password") : String(localized: "Show password"))
                        }
                    }
                    if let error {
                        Label(error, systemImage: "exclamationmark.circle.fill")
                            .font(.footnote).foregroundStyle(.red)
                    }
                    Button { Task { await signIn() } } label: {
                        Group { if busy { ProgressView() } else { Text(String(localized: "Anmelden")).font(.headline) } }
                            .frame(maxWidth: .infinity, minHeight: 34)
                    }
                    .buttonStyle(.borderedProminent).controlSize(.large)
                    .buttonBorderShape(.roundedRectangle(radius: 12))
                    .disabled(!canSignIn)
                    .padding(.top, 4)
                }
                .textInputAutocapitalization(.never).autocorrectionDisabled()
                .padding(.top, 36)

                HStack(spacing: 4) {
                    Text("Don't have an account?").foregroundStyle(.secondary)
                    Button(String(localized: "Create account"), action: openSignUp).fontWeight(.semibold)
                }
                .font(.subheadline).padding(.top, 28)

                Button(ownServer ? String(localized: "Use the Phosphor service") : String(localized: "Use your own server")) {
                    withAnimation(.snappy) { ownServer.toggle(); error = nil }
                    focus = ownServer ? .server : .email
                }
                .font(.footnote).padding(.top, 12)

                Text(verbatim: "v\(AppInfo.version)")
                    .font(.caption2).foregroundStyle(.tertiary).padding(.top, 40)
            }
            .frame(maxWidth: 440)   // iPad: not across the whole width
            .padding(.horizontal, 24).padding(.top, 72).padding(.bottom, 24)
            .frame(maxWidth: .infinity)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(Color(.systemGroupedBackground).ignoresSafeArea())
    }

    private var canSignIn: Bool {
        !busy && !email.isEmpty && !password.isEmpty && (!ownServer || !server.isEmpty)
    }

    /// A label above a filled, outlined field (Immich's form style); the outline turns accent while focused.
    private func labeled(_ title: String, @ViewBuilder field: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.subheadline.weight(.semibold))
            field()
                .padding(.horizontal, 14).frame(minHeight: 50)
                .background(Color(.secondarySystemGroupedBackground), in: .rect(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color(.separator), lineWidth: 1))
        }
    }

    /// Sign-up and storage setup happen on the accounts site; closing it comes back here.
    private func openSignUp() {
        let scene = UIApplication.shared.connectedScenes.first { $0.activationState == .foregroundActive } as? UIWindowScene
        scene?.keyWindow?.rootViewController?.present(SFSafariViewController(url: Self.signUp), animated: true)
    }

    private func signIn() async {
        busy = true; error = nil; defer { busy = false }
        let address = ownServer ? server : Self.hosted
        do {
            app.userName = try await CoreBridge.signIn(server: address, email: email, password: password)
            UserDefaults.standard.set(address, forKey: "serverURL")
            app.loggedIn = true
        } catch {
            self.error = error.localizedDescription
        }
    }
}
