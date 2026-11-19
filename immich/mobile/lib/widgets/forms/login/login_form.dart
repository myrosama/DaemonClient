import 'dart:async';
import 'dart:io';

import 'package:auto_route/auto_route.dart';
import 'package:dc_core_flutter/dc_core_flutter.dart' show AnyhowException;
import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_hooks/flutter_hooks.dart' hide Store;
import 'package:fluttertoast/fluttertoast.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/domain/models/store.model.dart';
import 'package:immich_mobile/entities/store.entity.dart';
import 'package:immich_mobile/extensions/build_context_extensions.dart';
import 'package:immich_mobile/extensions/translate_extensions.dart';
import 'package:immich_mobile/providers/auth.provider.dart';
import 'package:immich_mobile/providers/background_sync.provider.dart';
import 'package:immich_mobile/providers/gallery_permission.provider.dart';
import 'package:immich_mobile/providers/websocket.provider.dart';
import 'package:immich_mobile/repositories/local_files_manager.repository.dart';
import 'package:immich_mobile/routing/router.dart';
import 'package:immich_mobile/utils/provider_utils.dart';
import 'package:immich_mobile/widgets/common/immich_logo.dart';
import 'package:immich_mobile/widgets/common/immich_title_text.dart';
import 'package:immich_mobile/widgets/common/immich_toast.dart';
import 'package:immich_ui/immich_ui.dart';
import 'package:logging/logging.dart';
import 'package:url_launcher/url_launcher.dart';

/// The sign-in form's fields, by key (tests find them by these).
const kLoginServerKey = Key('login_server');
const kLoginEmailKey = Key('login_email');
const kLoginPasswordKey = Key('login_password');
const kCreateAccountKey = Key('login_create_account');

/// The hosted service's address, filled in for a first sign-in (D8).
const kHostedAddress = 'https://api.daemonclient.uz';

/// Accounts are made on the hosted portal; the user comes back and signs in.
final kSignUpUrl = Uri.parse('https://accounts.daemonclient.uz/signup');

/// One form for everyone (SPEC D8, P2 task 2.2): the server address (always
/// shown — self-hosted servers will be supported), email, password, and
/// Create account. The core signs in; see `AuthNotifier.loginWithCore`.
class LoginForm extends HookConsumerWidget {
  LoginForm({super.key});

  final log = Logger('LoginForm');

  String? _validateUrl(String? url) {
    if (url == null || url.trim().isEmpty) return 'login_form_err_invalid_url'.tr();
    return null;
  }

  String? _validateEmail(String? email) {
    if (email == null || email == '') return 'login_form_err_invalid_email'.tr();
    if (email.endsWith(' ')) return 'login_form_err_trailing_whitespace'.tr();
    if (email.startsWith(' ')) return 'login_form_err_leading_whitespace'.tr();
    if (email.contains(' ') || !email.contains('@')) {
      return 'login_form_err_invalid_email'.tr();
    }
    return null;
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final emailController = useTextEditingController.fromValue(TextEditingValue.empty);
    final passwordController = useTextEditingController.fromValue(TextEditingValue.empty);
    final serverController = useTextEditingController.fromValue(TextEditingValue.empty);
    final emailFocusNode = useFocusNode();
    final passwordFocusNode = useFocusNode();

    useEffect(() {
      // The address typed last time, else the hosted service's.
      serverController.text = Store.tryGet(StoreKey.serverUrl) ?? kHostedAddress;
      return null;
    }, []);

    Future<void> handleSyncFlow() async {
      final backgroundManager = ref.read(backgroundSyncProvider);

      await backgroundManager.syncLocal(full: true);
      await backgroundManager.syncRemote();
      await backgroundManager.hashAssets();

      if (Store.get(StoreKey.syncAlbums, false)) {
        await backgroundManager.syncLinkedAlbum();
      }
    }

    getManageMediaPermission() async {
      final hasPermission = await ref.read(localFilesManagerRepositoryProvider).hasManageMediaPermission();
      if (!hasPermission) {
        await showDialog(
          context: context,
          builder: (BuildContext context) {
            return AlertDialog(
              shape: const RoundedRectangleBorder(borderRadius: BorderRadius.all(Radius.circular(10))),
              elevation: 5,
              title: Text(
                'manage_media_access_title',
                style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold, color: context.primaryColor),
              ).tr(),
              content: SingleChildScrollView(
                child: ListBody(
                  children: [
                    const Text('manage_media_access_subtitle', style: TextStyle(fontSize: 14)).tr(),
                    const SizedBox(height: 4),
                    const Text('manage_media_access_rationale', style: TextStyle(fontSize: 12)).tr(),
                  ],
                ),
              ),
              actions: [
                TextButton(
                  onPressed: () => Navigator.of(context).pop(),
                  child: Text(
                    'cancel'.tr(),
                    style: TextStyle(fontWeight: FontWeight.w600, color: context.primaryColor),
                  ),
                ),
                TextButton(
                  onPressed: () {
                    ref.read(localFilesManagerRepositoryProvider).requestManageMediaPermission();
                    Navigator.of(context).pop();
                  },
                  child: Text(
                    'manage_media_access_settings'.tr(),
                    style: TextStyle(fontWeight: FontWeight.w600, color: context.primaryColor),
                  ),
                ),
              ],
            );
          },
        );
      }
    }

    bool isSyncRemoteDeletionsMode() => Platform.isAndroid && Store.get(StoreKey.manageLocalMediaAndroid, false);

    void showError(String message) {
      ImmichToast.show(context: context, msg: message, toastType: ToastType.error, gravity: ToastGravity.TOP);
    }

    login() async {
      TextInput.finishAutofillContext();

      String? token;
      try {
        token = await ref
            .read(authProvider.notifier)
            .signInWithCore(serverController.text, emailController.text.trim(), passwordController.text);
        // Only now, with the endpoint and the token in place: the API
        // repositories are rebuilt on them, then the user is fetched.
        invalidateAllApiRepositoryProviders(ref);
        if (!await ref.read(authProvider.notifier).saveAuthInfo(accessToken: token)) {
          await ref.read(authProvider.notifier).undoCoreSignIn();
          showError("login_form_failed_login".tr());
          return;
        }
        await ref.read(galleryPermissionNotifier.notifier).requestGalleryPermission();
        if (isSyncRemoteDeletionsMode()) {
          await getManageMediaPermission();
        }
        unawaited(handleSyncFlow());
        ref.read(websocketProvider.notifier).connect();
        unawaited(context.replaceRoute(const TabShellRoute()));
      } on AnyhowException catch (error) {
        // The core's own words: "wrong email or password", …
        final message = error.message.split('\n').first;
        showError(message.isEmpty ? "login_form_failed_login".tr() : message[0].toUpperCase() + message.substring(1));
      } catch (error, stack) {
        log.severe('Sign-in failed', error, stack);
        if (token != null) await ref.read(authProvider.notifier).undoCoreSignIn();
        showError("login_form_failed_login".tr());
      }
    }

    final form = AutofillGroup(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.max,
        children: [
          ImmichForm(
            submitText: 'login'.t(context: context),
            submitIcon: Icons.login_rounded,
            onSubmit: login,
            child: Column(
              spacing: ImmichSpacing.md,
              children: [
                ImmichTextInput(
                  key: kLoginServerKey,
                  controller: serverController,
                  label: 'login_form_endpoint_url'.t(context: context),
                  hintText: 'login_form_endpoint_hint'.t(context: context),
                  validator: _validateUrl,
                  keyboardAction: TextInputAction.next,
                  keyboardType: TextInputType.url,
                  autofillHints: const [AutofillHints.url],
                  autoCorrect: false,
                  onSubmit: (_, _) => emailFocusNode.requestFocus(),
                ),
                ImmichTextInput(
                  key: kLoginEmailKey,
                  controller: emailController,
                  focusNode: emailFocusNode,
                  label: 'email'.t(context: context),
                  hintText: 'login_form_email_hint'.t(context: context),
                  validator: _validateEmail,
                  keyboardAction: TextInputAction.next,
                  keyboardType: TextInputType.emailAddress,
                  autofillHints: const [AutofillHints.email],
                  onSubmit: (_, _) => passwordFocusNode.requestFocus(),
                ),
                ImmichPasswordInput(
                  key: kLoginPasswordKey,
                  controller: passwordController,
                  focusNode: passwordFocusNode,
                  label: 'password'.t(context: context),
                  hintText: 'login_form_password_hint'.t(context: context),
                  keyboardAction: TextInputAction.go,
                  validator: (password) => (password ?? '').isEmpty ? 'password_required'.tr() : null,
                  onSubmit: (ctx, _) => ImmichForm.of(ctx).submit(),
                ),
              ],
            ),
          ),
          ImmichTextButton(
            key: kCreateAccountKey,
            labelText: 'create_account'.t(context: context),
            icon: Icons.person_add_alt_1_rounded,
            variant: ImmichVariant.ghost,
            onPressed: () => launchUrl(kSignUpUrl, mode: LaunchMode.inAppBrowserView),
          ),
          ImmichTextButton(
            labelText: 'settings'.t(context: context),
            icon: Icons.settings,
            variant: ImmichVariant.ghost,
            onPressed: () => context.pushRoute(const SettingsRoute()),
          ),
        ],
      ),
    );

    return LayoutBuilder(
      builder: (context, constraints) {
        return SingleChildScrollView(
          child: Center(
            child: Container(
              constraints: const BoxConstraints(maxWidth: 300),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  SizedBox(height: constraints.maxHeight / 5),
                  const Column(
                    crossAxisAlignment: CrossAxisAlignment.center,
                    mainAxisAlignment: MainAxisAlignment.end,
                    children: [
                      ImmichLogo(heroTag: 'logo'),
                      Padding(padding: EdgeInsets.only(top: 8.0, bottom: 16), child: ImmichTitleText()),
                    ],
                  ),
                  Form(child: form),
                ],
              ),
            ),
          ),
        );
      },
    );
  }
}
