import AuthenticationServices
import SwiftUI

/// Sign in to one side of the app with the methods the backend has switched on: Google, Apple, or
/// a one-time code by email or text. There are no passwords.
struct SignInView: View {
    let role: AccountRole
    let onDone: () -> Void
    @Environment(AccountStore.self) private var accounts
    @Environment(\.webAuthenticationSession) private var webAuthentication
    @Environment(\.colorScheme) private var colorScheme
    @State private var methods: [SignInMethod]?
    @State private var methodsFailed = false
    @State private var appleNonce = ""
    @State private var emailInput = ""
    @State private var phoneInput = ""
    @State private var pending: PendingCode?
    @State private var code = ""
    @State private var resendAt = Date.distantPast
    @State private var working = false
    @State private var error: String?
    @FocusState private var codeFocused: Bool

    private struct PendingCode: Equatable {
        let channel: CodeChannel
        let target: String
    }

    private var subtitle: String {
        switch role {
        case .customer: "Sign in to keep your cards and rewards."
        case .partner: "Sign in to run your business on JOEYY. This is a separate account from a customer one."
        }
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    PageTitle(text: "Sign in")
                        .accessibilityAddTraits(.isHeader)
                        .accessibilityIdentifier("signIn.heading")
                    Text(subtitle)
                        .foregroundStyle(Color.muted)
                        .fixedSize(horizontal: false, vertical: true)

                    if let pending {
                        codeSection(for: pending)
                    } else if let methods {
                        methodsSection(methods)
                    } else if methodsFailed {
                        VStack(alignment: .leading, spacing: 12) {
                            Text("Couldn't reach JOEYY. Check your connection and try again.")
                                .foregroundStyle(Color.muted)
                                .fixedSize(horizontal: false, vertical: true)
                            Button("Try again") { Task { await loadMethods() } }
                                .buttonStyle(SecondaryButton())
                                .accessibilityIdentifier("signIn.retry")
                        }
                    } else {
                        ProgressView().frame(maxWidth: .infinity, minHeight: 120)
                    }

                    if let error {
                        Text(error)
                            .font(.footnote)
                            .foregroundStyle(.red)
                            .fixedSize(horizontal: false, vertical: true)
                            .accessibilityIdentifier("signIn.error")
                    }

                    Notice(
                        symbol: "iphone",
                        title: "Your data stays on this device for now",
                        message: "Signing in doesn't move or change what's on this phone yet."
                    )
                }
                .padding(24)
                .frame(maxWidth: 560)
                .frame(maxWidth: .infinity)
                .disabled(working)
            }
            .background { AppBackground() }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: onDone).accessibilityIdentifier("signIn.cancel")
                }
                if working {
                    ToolbarItem(placement: .principal) { ProgressView() }
                }
            }
            .task { await loadMethods() }
            .trackScreen("Sign in")
        }
    }

    // MARK: Sections

    @ViewBuilder private func methodsSection(_ methods: [SignInMethod]) -> some View {
        if methods.isEmpty {
            Text("Sign-in isn't available right now. Try again later.")
                .foregroundStyle(Color.muted)
        }
        if methods.contains(.google) {
            Button(action: signInWithGoogle) {
                Label("Continue with Google", systemImage: "g.circle")
            }
            .buttonStyle(SecondaryButton())
            .accessibilityIdentifier("signIn.google")
        }
        if methods.contains(.apple) {
            SignInWithAppleButton(.signIn) { request in
                appleNonce = SignInCrypto.randomString()
                request.requestedScopes = []
                request.nonce = SignInCrypto.sha256Hex(appleNonce)
            } onCompletion: { result in
                handleApple(result)
            }
            .signInWithAppleButtonStyle(colorScheme == .dark ? .white : .black)
            .frame(height: 52)
            .accessibilityIdentifier("signIn.apple")
        }
        if methods.contains(.email) {
            VStack(alignment: .leading, spacing: 12) {
                Text("Continue with email")
                    .font(.subheadline.weight(.medium))
                    .padding(.top, 8)
                inputField("Email address", text: $emailInput, identifier: "signIn.email")
                    .textContentType(.emailAddress)
                    .keyboardType(.emailAddress)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                Button("Email me a code") {
                    guard let email = EmailFormat.normalized(emailInput) else {
                        error = "Enter a valid email address."
                        return
                    }
                    sendCode(.email, to: email)
                }
                .buttonStyle(PrimaryButton())
                .disabled(!emailInput.contains("@"))
                .accessibilityIdentifier("signIn.sendEmailCode")
            }
        }
        if methods.contains(.phone) {
            VStack(alignment: .leading, spacing: 12) {
                Text("Or use your phone number")
                    .font(.subheadline.weight(.medium))
                    .padding(.top, 8)
                inputField("Mobile number", text: $phoneInput, identifier: "signIn.phone")
                    .textContentType(.telephoneNumber)
                    .keyboardType(.phonePad)
                Button("Text me a code") {
                    guard let number = PhoneNumberFormat.e164(phoneInput) else {
                        error = "Enter a mobile number, including the country code outside the US and Canada."
                        return
                    }
                    sendCode(.phone, to: number)
                }
                .buttonStyle(PrimaryButton())
                .disabled(phoneInput.filter(\.isNumber).count < 7)
                .accessibilityIdentifier("signIn.sendCode")
                Text("Message and data rates may apply.")
                    .font(.footnote)
                    .foregroundStyle(Color.muted)
            }
        }
    }

    private func codeSection(for pending: PendingCode) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(pending.channel == .email
                ? "Enter the 6-digit code we emailed to \(pending.target). Check your spam folder if it isn't there."
                : "Enter the 6-digit code sent to \(pending.target).")
                .font(.subheadline)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("signIn.codePrompt")
            inputField("Code", text: $code, identifier: "signIn.code")
                .textContentType(.oneTimeCode)
                .keyboardType(.numberPad)
                .focused($codeFocused)
                .onChange(of: code) { code = String(code.filter(\.isNumber).prefix(6)) }
            Button("Sign in") { verifyCode(pending) }
                .buttonStyle(PrimaryButton())
                .disabled(code.count != 6)
                .accessibilityIdentifier("signIn.verify")
            TimelineView(.periodic(from: .now, by: 1)) { context in
                let wait = Int(resendAt.timeIntervalSince(context.date).rounded(.up))
                HStack {
                    Button(pending.channel == .email ? "Change email" : "Change number") {
                        self.pending = nil
                        code = ""
                        error = nil
                    }
                    .accessibilityIdentifier("signIn.change")
                    Spacer()
                    Button(wait > 0 ? "Send a new code in \(wait)s" : "Send a new code") {
                        sendCode(pending.channel, to: pending.target)
                    }
                    .disabled(wait > 0)
                }
                .buttonStyle(TextButton())
                .font(.subheadline)
                .frame(minHeight: 44)
            }
        }
    }

    private func inputField(_ title: String, text: Binding<String>, identifier: String) -> some View {
        TextField(title, text: text)
            .padding(12)
            .frame(minHeight: 44)
            .background(Color.surface, in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Color.rule))
            .accessibilityIdentifier(identifier)
    }

    // MARK: Actions

    private func loadMethods() async {
        methodsFailed = false
        do {
            methods = try await accounts.availableMethods()
        } catch {
            methodsFailed = true
        }
    }

    private func run(_ work: @escaping @MainActor () async throws -> Void) {
        error = nil
        working = true
        Task {
            defer { working = false }
            do {
                try await work()
            } catch let failure as ASWebAuthenticationSessionError where failure.code == .canceledLogin {
                // The person closed the Google sheet.
            } catch {
                self.error = error.localizedDescription
            }
        }
    }

    private func handleApple(_ result: Result<ASAuthorization, any Error>) {
        switch result {
        case .success(let authorization):
            guard let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
                  let data = credential.identityToken, let token = String(data: data, encoding: .utf8)
            else {
                error = "Sign in with Apple didn't work. Try again."
                return
            }
            let nonce = appleNonce
            run { try await finish(.apple(identityToken: token, nonce: nonce)) }
        case .failure(let failure):
            if (failure as? ASAuthorizationError)?.code == .canceled { return }
            error = "Sign in with Apple didn't work. Try again."
        }
    }

    private func signInWithGoogle() {
        guard let clientID = AppConfiguration.googleIOSClientID else {
            error = AuthError.notConfigured("Google sign-in isn't set up in this build yet. Use email instead.").localizedDescription
            return
        }
        run { try await finish(try await GoogleOAuth(clientID: clientID).signIn(using: webAuthentication)) }
    }

    private func sendCode(_ channel: CodeChannel, to target: String) {
        run {
            let sent = try await accounts.sendCode(channel, to: target)
            pending = PendingCode(channel: channel, target: target)
            code = ""
            resendAt = .now.addingTimeInterval(TimeInterval(sent.resendAfter))
            codeFocused = true
        }
    }

    private func verifyCode(_ pending: PendingCode) {
        let entered = code
        run { try await finish(.code(pending.channel, target: pending.target, code: entered)) }
    }

    private func finish(_ proof: SignInProof) async throws {
        try await accounts.signIn(role, with: proof)
        onDone()
    }
}
/// The You tab's account control for one side, next to the page title: sign in, or see which
/// sign-in is used and sign out.
struct AccountButton: View {
    let role: AccountRole
    @Environment(AccountStore.self) private var accounts
    @State private var signingIn = false
    @State private var showingAccount = false

    var body: some View {
        let account = accounts.account(for: role)
        Button {
            if account == nil { signingIn = true } else { showingAccount = true }
        } label: {
            Image(systemName: account == nil ? "person.crop.circle" : "person.crop.circle.fill")
                .font(.title3)
                .frame(width: 44, height: 44)
        }
        .buttonStyle(.borderless)
        .accessibilityLabel(account == nil ? "Sign in" : "Account")
        .accessibilityValue(account.map { "Signed in with \($0.method.label)" } ?? "")
        .accessibilityIdentifier("account.button")
        .sheet(isPresented: $signingIn) {
            SignInView(role: role) { signingIn = false }
        }
        .confirmationDialog(
            account.map { "Signed in with \($0.method.label)" } ?? "Account",
            isPresented: $showingAccount,
            titleVisibility: .visible
        ) {
            Button("Sign out", role: .destructive) {
                Task { await accounts.signOut(role) }
            }
        } message: {
            Text(role == .partner
                ? "Your business data stays on this device for now."
                : "Your cards stay on this device for now.")
        }
    }
}
