import AuthenticationServices
import SwiftUI

/// Sign in to one side of the app with Apple, Google, or a phone number and text code.
/// There is no email or password.
struct SignInView: View {
    let role: AccountRole
    let onDone: () -> Void
    @Environment(AccountStore.self) private var accounts
    @Environment(\.webAuthenticationSession) private var webAuthentication
    @Environment(\.colorScheme) private var colorScheme
    @State private var appleNonce = ""
    @State private var phoneInput = ""
    @State private var sentTo: String?
    @State private var code = ""
    @State private var resendAt = Date.distantPast
    @State private var working = false
    @State private var error: String?
    @FocusState private var codeFocused: Bool

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

                    Button(action: signInWithGoogle) {
                        Label("Continue with Google", systemImage: "g.circle")
                    }
                    .buttonStyle(SecondaryButton())
                    .accessibilityIdentifier("signIn.google")

                    Text("Or use your phone number")
                        .font(.subheadline.weight(.medium))
                        .padding(.top, 8)
                    phoneSection

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
            .trackScreen("Sign in")
        }
    }

    @ViewBuilder private var phoneSection: some View {
        if let sentTo {
            VStack(alignment: .leading, spacing: 12) {
                Text("Enter the 6-digit code sent to \(sentTo).")
                    .font(.subheadline)
                    .fixedSize(horizontal: false, vertical: true)
                TextField("Code", text: $code)
                    .textContentType(.oneTimeCode)
                    .keyboardType(.numberPad)
                    .focused($codeFocused)
                    .padding(12)
                    .frame(minHeight: 44)
                    .background(Color.surface, in: RoundedRectangle(cornerRadius: 8))
                    .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Color.rule))
                    .accessibilityIdentifier("signIn.code")
                    .onChange(of: code) { code = String(code.filter(\.isNumber).prefix(6)) }
                Button("Sign in") { verifyCode(for: sentTo) }
                    .buttonStyle(PrimaryButton())
                    .disabled(code.count != 6)
                    .accessibilityIdentifier("signIn.verify")
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    let wait = Int(resendAt.timeIntervalSince(context.date).rounded(.up))
                    HStack {
                        Button("Change number") {
                            self.sentTo = nil
                            code = ""
                        }
                        Spacer()
                        Button(wait > 0 ? "Send a new code in \(wait)s" : "Send a new code") { sendCode(to: sentTo) }
                            .disabled(wait > 0)
                    }
                    .buttonStyle(TextButton())
                    .font(.subheadline)
                    .frame(minHeight: 44)
                }
            }
        } else {
            VStack(alignment: .leading, spacing: 12) {
                TextField("Mobile number", text: $phoneInput)
                    .textContentType(.telephoneNumber)
                    .keyboardType(.phonePad)
                    .padding(12)
                    .frame(minHeight: 44)
                    .background(Color.surface, in: RoundedRectangle(cornerRadius: 8))
                    .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Color.rule))
                    .accessibilityIdentifier("signIn.phone")
                Button("Text me a code") {
                    guard let number = PhoneNumberFormat.e164(phoneInput) else {
                        error = "Enter a mobile number, including the country code outside the US and Canada."
                        return
                    }
                    sendCode(to: number)
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

    // MARK: Actions

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
            error = AuthError.notConfigured("Google sign-in isn't set up yet. Use Apple or your phone number.").localizedDescription
            return
        }
        run { try await finish(try await GoogleOAuth(clientID: clientID).signIn(using: webAuthentication)) }
    }

    private func sendCode(to number: String) {
        run {
            let sent = try await accounts.sendPhoneCode(to: number)
            sentTo = number
            code = ""
            resendAt = .now.addingTimeInterval(TimeInterval(sent.resendAfter))
            codeFocused = true
        }
    }

    private func verifyCode(for number: String) {
        let entered = code
        run { try await finish(.phone(number: number, code: entered)) }
    }

    private func finish(_ proof: SignInProof) async throws {
        try await accounts.signIn(role, with: proof)
        onDone()
    }
}

/// The You tab's account rows for one side: sign in, or who's signed in and sign out.
struct AccountSection: View {
    let role: AccountRole
    @Environment(AccountStore.self) private var accounts
    @State private var signingIn = false
    @State private var confirmingSignOut = false

    var body: some View {
        Section {
            if let account = accounts.account(for: role) {
                LabeledContent("Signed in with", value: account.method.label)
                    .frame(minHeight: 44)
                    .accessibilityIdentifier("account.status")
                Button("Sign out", role: .destructive) { confirmingSignOut = true }
                    .frame(minHeight: 44)
                    .accessibilityIdentifier("account.signOut")
            } else {
                Button {
                    signingIn = true
                } label: {
                    HStack {
                        Text("Sign in")
                        Spacer()
                        Image(systemName: "person.crop.circle").font(.subheadline)
                    }
                    .frame(minHeight: 44)
                }
                .accessibilityIdentifier("account.signIn")
            }
        } header: {
            Text("Account").foregroundStyle(.tint)
        } footer: {
            Text(role == .partner
                ? "Apple, Google, or phone number. Your business data stays on this device for now."
                : "Apple, Google, or phone number. Your cards stay on this device for now.")
                .foregroundStyle(Color.muted)
        }
        .sheet(isPresented: $signingIn) {
            SignInView(role: role) { signingIn = false }
        }
        .confirmationDialog("Sign out?", isPresented: $confirmingSignOut, titleVisibility: .visible) {
            Button("Sign out", role: .destructive) {
                Task { await accounts.signOut(role) }
            }
        }
    }
}
