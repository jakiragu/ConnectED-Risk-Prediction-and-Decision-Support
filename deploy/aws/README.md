# ConnectED AWS deployment runbook

Prepared for branch `fix/45-dashboard-insights-improvement`, commit `e13a970ad9fafee9a90a1e1d6f5db469c716e8a8` (inspected 9 November 2026).

This is a deployable candidate with local validation, not an already verified live AWS deployment. No AWS resources were created from ChatGPT. The code was not pushed. Allow roughly three hours if AWS access, Docker and Google Console access are ready; provisioning or account restrictions may extend it.

## What changes, and why

The original branch has password login, first-login password changes, two session contexts and working Remember me. Its school Forgot password and Google controls are previews; Angaza has no recovery control. `local/setup-aws.js` is an emulator setup with a dummy account ID, not production infrastructure.

The patch adds:

- A Python deployment driver using AWS CLI, Docker and the installed Node dependencies. No Terraform, CDK or SAM installation needed.
- CloudFormation for a private S3 frontend behind HTTPS CloudFront; AppSync; one bundled GraphQL Lambda; separate prediction, report and Python scorer Lambdas; DynamoDB with all three GSIs; EventBridge; Step Functions; report/model buckets; two Cognito pools; groups; IAM roles; seven-day logs and an asynchronous prediction-failure queue.
- All 42 Query and 49 Mutation resolvers generated from the branch's own resolver map. The existing business handlers and model files are retained.
- School ForgotPassword/ConfirmForgotPassword API calls. Angaza recovery uses Cognito's hosted recovery page.
- Google Authorization Code + PKCE, state and nonce checks, separate callbacks and sessions, and OAuth refresh-token handling.
- A pre-sign-up trigger that links an invited, confirmed account to Google, preserving its Cognito subject and assignments. Uninvited Google accounts cannot provision themselves.
- Correct AppSync error-type handling, including suspended-school errors.

The browser clients have no secret and cannot write `custom:school_id`. The new school pool declares this attribute mutable because Cognito account linking requires mutable destination attributes; only trusted backend administration can set it. Do not try to reuse an old pool with an immutable school_id attribute for this linking design.

For this time-limited deployment, CloudFront + S3 replaces the proposed Amplify Hosting layer. You receive an AWS HTTPS URL without registering a domain or connecting GitHub. Both portals share the frontend and API but have separate Cognito user pools. The application's existing backend checks enforce pool and school boundaries.

## Before starting: gather these

1. AWS account and deployment credentials. Use one account and `eu-west-1` throughout. The deployer needs CloudFormation, IAM creation/PassRole, Lambda, ECR, S3, DynamoDB, AppSync, Cognito, CloudFront, EventBridge, Step Functions, SQS and CloudWatch Logs permissions. A dedicated sandbox deployment administrator is the simplest setup; application runtime roles are generated separately. Never create root access keys.
2. Access to Google Cloud Console to create a Google OAuth Web Application. You do not need a Google service-account key.
3. Your real email for the first Angaza account and a real email for a school admin. Google login requires that the invited email matches the Google email.
4. Windows tools: Git, AWS CLI v2, Node 22 LTS or newer, Python 3.10+ and Docker Desktop running **Linux containers**. Close the local Docker lab/Wazuh VM to free RAM before building the scorer. Docker pulls Python/scientific libraries and pushes a substantial image; a stable connection matters.
5. The branch's checked-in `ml/models/logreg-v1` package. The script publishes this exact package and invokes its self-test; it does not retrain anything. `ml/README-model.md` still describes XGBoost, but the current code and manifest use Logistic Regression.

If tools are absent, install from https://aws.amazon.com/cli/ , https://nodejs.org/ , https://www.python.org/downloads/windows/ and https://www.docker.com/products/docker-desktop/ . Reopen PowerShell after installation. Use `py` instead of `python` below if that is your working Python launcher.

## 0–20 minutes: prepare and authenticate

Use a fresh checkout to avoid disturbing uncommitted work:

```powershell
git clone --branch fix/45-dashboard-insights-improvement --single-branch https://github.com/jakiragu/ConnectED-Risk-Prediction-and-Decision-Support.git connected-aws
cd connected-aws
git rev-parse HEAD
```

If HEAD differs from the inspected commit, inspect the newer changes; the patch check must succeed before applying. The patch does not overwrite files without Git checking context.

Extract `connected-aws-deployment-kit.zip` to a convenient folder. Set the patch path accordingly:

```powershell
git switch -c feat/45-aws-deployment-auth
git apply --check "$HOME\Downloads\connected-aws-deployment-kit\connected-aws-deployment.patch"
git apply "$HOME\Downloads\connected-aws-deployment-kit\connected-aws-deployment.patch"
```

Use your existing authenticated AWS profile if available. Otherwise configure IAM Identity Center with `aws configure sso --profile connected-deploy`, followed by `aws sso login --profile connected-deploy`. If your account uses a dedicated IAM deployment user's access keys instead, run `aws configure --profile connected-deploy` and enter them locally. Never put keys in the frontend, Git or this chat.

```powershell
$env:AWS_PROFILE = "connected-deploy"
$env:AWS_DEFAULT_REGION = "eu-west-1"
aws sts get-caller-identity
python deploy/aws/deploy.py check
```

Verify the displayed account ID. In AWS Console open **Billing and Cost Management → Free Tier/Credits**. Check which plan and credits actually apply. Create a small cost-alert budget, for example USD 1 and USD 5 alerts to your email. Budgets notify; they do not stop usage.

Do not run `npm run setup`, `npm run aws:setup` or `npm run db:seed` against this deployment. The existing seed command resets by default when run through npm and uses publicly known development credentials.

## 20–90 minutes: provision and publish

From the patched repository root, with Docker running:

```powershell
python deploy/aws/deploy.py deploy
```

This command performs the following, in sequence:

1. Prints the authenticated AWS account, region and stack.
2. Installs the locked Node packages and bundles the API/report/prediction/linking handlers.
3. Creates a private artifact bucket and ECR repository if absent, then uploads the versioned Node ZIP.
4. Builds the Python scorer for Linux AMD64, pushes it to ECR and uses its immutable image digest.
5. Creates the CloudFormation stack `connected-demo` with the infrastructure above.
6. Publishes `ml/models/logreg-v1`, runs the scorer self-test and only then updates `models/current.json`.
7. Writes ignored `.env.aws.local`, builds the frontend with AWS endpoints and uploads it to the private web bucket. It requests a CloudFront invalidation.
8. Prints the school sign-in URL and Angaza URL.

Keep the script running while you prepare Google Console in another window. CloudFormation → `connected-demo` → Events shows resource progress. A successful frontend upload is not proof that report cards and predictions work: complete the live tests below.

The Python driver explicitly clears emulator endpoints for deployment helpers and the frontend. It leaves your development `.env` alone. Its `.state` directory records nonsecret deployment identifiers. Keep that directory locally for later `google`, `web` and retry commands; do not commit it.

If only model publication failed after CloudFormation succeeded:

```powershell
python deploy/aws/deploy.py model
python deploy/aws/deploy.py web
```

To retry a failed deployment without rebuilding an image that was already pushed:

```powershell
python deploy/aws/deploy.py deploy --reuse-image
```

Resolve the first CloudFormation failure before retrying. Do not change region/stack names randomly: that creates another deployment. If you use a different region or stack, pass the same `--region` and `--stack` to **every** phase.

## 90–110 minutes: create real accounts

```powershell
python deploy/aws/deploy.py staff --email "YOUR_REAL_EMAIL" --first "Jason" --last "Kiragu"
python deploy/aws/deploy.py outputs
```

The staff command creates both the Angaza Cognito user/group membership and the required DynamoDB staff record. Creating only a Cognito console user is insufficient. The command prints a one-time temporary password locally. Save it securely.

1. Open `SiteUrl/angaza` and sign in with that temporary password. Choose a permanent password.
2. In the Angaza console create one school, including its structured location/time zone.
3. Add its school administrator with a real email address, and record the temporary password returned by the app.
4. Open `SiteUrl/sign-in` in a separate browser session; log in as that admin and choose a permanent password.
5. Create a small class, a teacher, students, terms and assessments through the normal app. Use 2–5 synthetic students for the first live test. Configure all required subjects/checkpoints and attendance before expecting a valid risk prediction.

New AWS Cognito pools generate new user IDs. Local teacher IDs, assignments, interventions and historical authors cannot simply be copied unchanged and expected to match. This kit starts with a new empty database and does not migrate existing school records. A full historical-data migration requires an explicit old-sub → new-sub remapping and validation, outside this three-hour clean-deployment path. Existing app/demo data must be recreated or migrated separately; do not describe the empty deployment as a completed data migration.

## 110–140 minutes: enable Google on both pools

Run `python deploy/aws/deploy.py outputs` and note `SchoolDomain` and `AngazaDomain`.

In https://console.cloud.google.com/ :

1. Select or create a project, e.g. `ConnectED`.
2. Open **Google Auth Platform** (older menus: APIs & Services → OAuth consent screen).
3. Configure Branding: app name `ConnectED`, support email and developer contact email. For a personal Gmail-based test, select an External audience. Use basic `openid`, `email`, `profile` identity scopes only.
4. If using Testing mode, add your Angaza and school-admin Google addresses under Audience → Test users. Keep the first demo restricted to those accounts; do not wait for broad public branding approval tonight.
5. Clients → Create client → **Web application**.
6. Add both Cognito domain origins under Authorized JavaScript origins: `SchoolDomain` and `AngazaDomain`, without paths.
7. Add exactly these Authorized redirect URIs:

   - `SchoolDomain/oauth2/idpresponse`
   - `AngazaDomain/oauth2/idpresponse`
   - `SiteUrl/auth/google-link` (your CloudFront address; used when someone links their own Google account from My Profile)

   Replace the output labels with their complete `https://...amazoncognito.com` values. These are **not** your CloudFront callback URLs. The CloudFormation client config already sets the app callbacks separately at `SiteUrl/auth/callback` and `SiteUrl/angaza/auth/callback`.
8. Save the client ID and client secret securely.

Then run:

```powershell
python deploy/aws/deploy.py google
```

The script prints the three exact Google redirect URIs again, prompts for the client ID and hidden secret, and updates both pool providers and both app clients. It uses a CloudFormation `NoEcho` parameter and deletes its temporary parameter file. Neither secret is written to the browser configuration. Later `deploy` runs preserve the existing Google parameters.

Google account-linking rules in this patch:

- An administrator must already have created the account in the correct pool.
- Complete the first temporary-password login before trying Google.
- The existing user must be enabled, confirmed, have a verified email and the expected role.
- The Google email must be verified and authoritative: Gmail, or Google Workspace with a matching signed `hd` claim. A Google consumer account whose email is an unrelated third-party mailbox must use password login for this release.
- First Google login links to the existing Cognito subject. The teacher's school ID, role and assignments are retained. It does not grant Angaza access to a school account.
- A single person can have two independently invited accounts, one per pool. Each portal links only inside its own pool.

Test in an incognito window: log in through Google, confirm the same account/school, reload, and verify the right portal remains signed in. Test an uninvited Google address and confirm rejection. For a long-session test, leave the tab open past the one-hour token lifetime; the OAuth refresh path must also work.

## Password recovery and Remember me

School portal: click Forgot password → enter verified account email → retrieve code from email → enter code and new password → sign in using the new password. A wrong code must fail and must not show success.

Angaza portal: click Forgot password → Cognito-hosted recovery page → enter email/code/new password → use the hosted login or return to `SiteUrl/angaza/sign-in`. This route is wired to the Angaza pool, not the school pool.

Until the mail phase below has run, the reset code comes from Cognito's default sender, `no-reply@verificationemail.com` (check spam; about 50 messages per day per account, shared across pools). Google itself does not send these reset emails.

Remember me was already implemented: checked uses localStorage; unchecked uses sessionStorage. The new OAuth flow preserves that choice. Both portals retain separate keys. Browser session restoration can sometimes restore sessionStorage tabs; this is not a strong shared-computer security boundary. Sign out explicitly on shared devices. App logout clears the app's session; it does not sign the person out of their Google account or implement global token revocation.

## Linking a personal Google account

A person can link **one** personal Google account (say `janedoe@gmail.com`) to their school-issued account from **My Profile → Sign-in Methods**, then use "Continue with Google". Both ways in open the same account. Angaza staff do the same from the console's My Profile.

**Nothing changes when you deploy this.** Every school starts at *Nobody*. A school administrator turns it on in **Settings → Accounts** (teachers only, or teachers and administrators), sees everyone's link there, and can remove any link. Automatic linking, where the Google address equals the account email, keeps working as before for anyone who has not removed their link.

What the deployment changes, all in place (no pool or table is replaced, and existing records need no migration):

- **Attribute mapping.** The Google provider no longer maps onto `email`, `email_verified` or `name`, so a Google sign-in cannot overwrite the school email or name. Google's address and verified flag now arrive in the standard attributes `nickname` and `profile`, which only the pre-sign-up trigger reads. No custom attribute is added.
- **Permissions.** The API may link and unlink identities and end sessions in both pools; the trigger may read and write one sign-in record in the table.
- **Google client.** Add `SiteUrl/auth/google-link` to the OAuth client's Authorised redirect URIs (step 7 above). `deploy.py` prints the exact address after `deploy` and during `google`. Until it is added, Google shows `redirect_uri_mismatch` when someone tries to link.

How it is kept safe: the server checks Google's signed answer itself (genuine, for this client, unexpired, and answering that person's single-use request). It links Google's permanent account id; the address is display only. Linking, changing, removing, and widening the school's setting need a sign-in from the last ten minutes, or the app asks for the password again. Removing or changing a link ends the person's sessions and emails their account address. The API refuses their earlier sessions at once; a page already open on a device that stays offline can remain visible until it next talks to the server, and Cognito's own tokens last up to an hour. Every link, change, removal and setting change is written as an `ACCOUNTAUDIT#` record in the school's partition (the Angaza partition for staff).

**Check after deploying, in this order** (these need real Cognito and Google, so they are not covered by the automated tests):

1. An account whose email is a Google address still signs in with "Continue with Google", and its email and name on My Profile are unchanged afterwards.
2. Set Settings → Accounts to *Teachers and administrators*, link a different Gmail address from My Profile, log out, and sign in with that Google account: the same account opens.
3. Remove the link, then try "Continue with Google" with it: refused. For an account whose Google address equals its email, the refusal says the link was removed and to link again from My Profile.

**Demo reset.** A reset restores database records only: the school's setting and the "do not relink automatically" markers go back to the snapshot, while links in Cognito stay. The app follows Cognito for whether a link exists (a link made after the snapshot shows as linked, without its address, and can still be removed). Take a new snapshot after choosing the setting, or each reset returns the school to *Nobody*.

**Locally** there is no Google: `npm run api` starts a stand-in account chooser on `GOOGLE_STANDIN_URL` (see `.env.example`), and links are kept in the local table because cognito-local cannot link identities.

## Deleting accounts and schools

Both deletions are permanent. Nothing here can be undone from the app.

**A deactivated account** (school administrators, Teachers page). A red *Delete* link appears on deactivated rows only. It removes the Cognito account, any linked Google account and its claim, the person's email and other details, and their subject assignments. A record with only their name stays, marked `DELETED`, so marks, interventions and archived classes still name them. Their email can then be used for a new account. The administrator must have signed in within the last ten minutes, or the app asks for the password. The person is not emailed. The deletion is written as an `ACCOUNTAUDIT#` record (`ACCOUNT_DELETED`).

**A school** (Angaza staff, the school's page in the console). *Delete school* appears while the school is suspended, and also on a school that has no administrator yet (one registered by mistake); once a school has an administrator the page offers *Suspend* instead. You type its name, and need a sign-in from the last ten minutes. It removes every record in the school's partition, its Cognito accounts, Google claims, report-card PDFs (every version) and its name reservation. One line stays in the console, under *Deleted schools*, with who deleted it and when. Nobody at the school is emailed.

A school is removed in slices of about 18 seconds. It switches to *Deleting…* first, which blocks every sign-in at once, and the console page asks for the next slice until none is left. **Keep the page open until it finishes.** If it is closed or a slice fails, the school stays blocked and opening its page again carries on; nothing remembers a position, each slice removes whatever is still there.

**How long it takes** depends on the table. On the default provisioned 5 write units, expect roughly 5 records a second, so about an hour for 20,000 records. A newly registered school with a handful of records is gone in one request. For a large school you can switch `DynamoBillingMode` to `PAY_PER_REQUEST` first (requests are then billed).

What the deployment changes, all in place (no pool, table or bucket is replaced; existing records need no migration):

- **Permissions.** The API may delete users in the school pool (`AdminDeleteUser`), and list and delete object versions in the report bucket. Angaza accounts are never deleted by the app.
- **API.** Three mutations (`deleteTeacher`, `deleteSchool`, `continueSchoolDeletion`), two school states (`DELETING`, `DELETED`) and five optional fields on `PlatformSchool`.

**Check after deploying** (these need real Cognito and S3, so the automated tests use stand-ins for them):

1. Add a test teacher, deactivate them, delete them. In the Cognito console the user is gone from the school pool. Add a teacher with the same email: it works.
2. Register a test school and delete it straight away. Register another, add an administrator, suspend it, delete it. It appears under *Deleted schools*, its administrator is gone from the school pool, and the same name can be registered again.
3. If the test school had report cards, the `report-cards/<school id>/` prefix in the report bucket is empty with *Show versions* on.

**Demo reset.** A reset restores database records only. After one, a deleted school's or person's records come back, but they cannot sign in: their Cognito accounts are gone and are not recreated. Do not delete the demo school or demo accounts you plan to show; use a throwaway school and teacher for the demonstration.

## Account emails (SES)

ConnectED emails people when their account changes:

| When | Email | Sent by |
|---|---|---|
| Angaza adds a school administrator; an administrator adds a teacher; `deploy.py staff` | Invitation with sign-in link and temporary password | API / staff script, through SES |
| Reset for someone who never signed in | The invitation again, with a new temporary password | API |
| Reset for someone who has signed in | "Your password was reset", with a temporary password | API |
| Forgot password | Reset code in ConnectED's wording | Cognito (wording from the `auth-mail` trigger) |
| Forgot-password reset finished | "Your password was changed" | `auth-mail` trigger |
| Google linked automatically at sign-in (Google address equals the account email) | "Google sign-in was added" | `google-link` trigger |
| Someone links or changes a Google account from My Profile | "Google sign-in was added" / "The Google account was changed", naming the Google account, to the account's own address | API |
| A Google link is removed (by the person, or by an administrator, who is named) | "Google sign-in was removed" | API |
| School suspended or reactivated | Notice to its active administrators (never Angaza's reason) | API |

A failed email never undoes the account change. The app shows the administrator the temporary password and why the email failed, so they can pass it on themselves. Until a sender is set up, nothing is emailed and every handover works that way.

### Turning it on

1. Run `python deploy/aws/deploy.py deploy` once with this version of the code. It uploads the `auth-mail` function; the mail phase refuses to run before this.
2. Choose a sender address you can receive mail at (later, an address on your own domain: mail from a domain you control is far less likely to land in spam).
3. Run:

   ```powershell
   python deploy/aws/deploy.py mail --sender "no-reply@yourdomain.org"
   ```

   It asks SES to verify the address, waits until you click the link in the verification email, checks whether SES is in its sandbox, then updates the stack: both user pools send through SES from that address and the Lambdas get permission to send.

   The first update makes Cognito create a service-linked role for SES. Your deploying identity needs `iam:CreateServiceLinkedRole`; an administrator profile has it.

4. Later `deploy` runs keep the sender.

### The SES sandbox

A new SES account can send only to addresses that are themselves verified, at most 200 emails a day. The mail phase says when this applies. For a live test, verify each test recipient:

```powershell
aws sesv2 create-email-identity --email-identity person@example.org --region eu-west-1
```

For real schools, request production access: SES console, Account dashboard, Request production access. Describe the mail honestly: transactional account emails (invitations, password resets, security notices) to staff added by an administrator; no marketing. Until it is granted, emails to unverified people fail and the app falls back to showing the password.

### Checks

- Add a teacher with a verified address: the invitation arrives, the link opens `/sign-in`, the temporary password works once.
- Reset them before and after their first sign-in: "invitation" the first time, "password was reset" the second.
- Forgot password in each portal: the code arrives in ConnectED's wording; after the reset a "password was changed" email follows.
- Link Google: "Google sign-in was added" arrives.
- Suspend and reactivate a test school: its administrators get both notices.
- Logs: `/aws/lambda/connected-demo-api` and `-auth-mail` show `svc: mailer` lines with `sent: true`. They never contain recipient addresses.

Locally nothing is sent: each email is printed in the `npm run api` terminal and saved under `local/.data/mail` (open the `.html` files in a browser).

## Results by SMS (Africa's Talking)

Report cards → **Text parents** sends each guardian the published result. The API function calls Africa's Talking over HTTPS; nothing else in the stack changes, and the table is untouched (guardian contacts are new attributes on student items; delivery records are new `RESULTSMS#…` items beside the report cards).

### Turning it on

1. Create an account at africastalking.com. The **sandbox** app is free: messages appear in their web simulator, not on phones. Generate its API key under Settings → API Key.
2. Run, after `deploy` has run once with this code:

   ```bash
   python deploy/aws/deploy.py sms
   ```

   It asks for the username (`sandbox`, or your live app's username), the API key (hidden; a NoEcho parameter, given only to the API function) and, for a live app, an approved sender ID (Enter uses the shared default sender).
3. To reach real phones, run it again with the live app's username and key. The live account needs credit; each message is one or two SMS (the confirmation dialog shows which).

Until step 2, the Report cards page shows the SMS column and the button, and the dialog explains that SMS is not set up.

### Guardian numbers for the demo school

Add them through Settings → Import → Students: a file with `admission_no, first_name, last_name, class, guardian_name, guardian_phone` adds the contact to students already in ConnectED. Then take a new demo snapshot, or a demo reset removes them. A reset also removes SMS delivery records, so every result shows *Not sent* again.

### Checks

- A sandbox send shows *Sent* on each row and the messages in the Africa's Talking simulator.
- A wrong key: the dialog's send ends with "The SMS account details on this deployment are wrong." and nothing else is attempted.
- CloudWatch logs for the API function show `"svc":"sms"` lines without phone numbers.

## 140–180 minutes: live acceptance checks

Do not mark the deployment complete until these pass:

- Site opens over HTTPS; refreshing `/dashboard` and `/angaza` works.
- School and Angaza password sign-ins work, including first-login password changes.
- Recovery succeeds with a real received code in each pool, and wrong codes fail.
- Google signs in to both invited accounts and retains the same Cognito subject. Uninvited accounts are rejected.
- School account cannot call Angaza operations; Angaza token cannot call school operations. Existing tenant checks still refuse another school's records.
- Admin creates a class and teacher, enters marks and attendance, calculates and publishes a small checkpoint.
- Published results trigger a Step Functions execution and generate a downloadable PDF in the report bucket.
- A qualifying T1M/T1F/T2M/T2F/T3M publication triggers the prediction Lambda; risk scores and SHAP appear. At-risk cases produce DiCE targets or an explicit fallback/status. A successful model self-test alone does not validate DiCE.
- Check Lambda logs for `connected-demo-api`, `connected-demo-prediction`, `connected-demo-scorer` and `connected-demo-report`; inspect the failure queue if predictions do not finish.
- Edit offline, reconnect, verify sync/conflict handling with real hosted API endpoints.

AppSync's hard request limit is 30 seconds even though the API Lambda allows longer execution. This patch preserves the existing synchronous bulk calculation/publication/promotion handlers. A large whole-school operation can exceed that limit and the Lambda can continue after the browser receives a timeout. Start with one small class; inspect persisted state before retrying a timed-out mutation. Larger deployments need those bulk actions changed to start asynchronous jobs with polling. This is a real remaining scale limitation, not solved by increasing browser/Lambda timeouts.

## Costs and free-tier boundaries

This design avoids EC2, NAT gateways, load balancers, custom domains and always-running servers. It is not a guarantee that every service is free for your account.

- New AWS accounts under the post-July-2025 program get credits and a free-plan window of up to six months (or until credits run out). Older accounts have different eligibility. Check your own Billing console before deployment.
- Both pools use Cognito Lite. Cognito's current free allowance is 10,000 direct/social monthly active users across the account/organization; it is not doubled by two pools.
- DynamoDB defaults to provisioned 5 read + 5 write units on the table and each of three GSIs: **20 RCUs and 20 WCUs total**. This fits within the commonly applicable 25/25 provisioned allowance if other tables do not already consume it. Storage and other conditions still apply. It can throttle bulk workloads. If you choose to switch `DynamoBillingMode` to `PAY_PER_REQUEST`, requests are billed/consume credits; do not assume provisioned free units cover them.
- The scientific Python image may exceed ECR's 500 MB private-image storage allowance. Its actual pushed size determines storage cost/credit use. Lambda compute, AppSync calls, S3 objects/requests, CloudFront, Step Functions, SQS and CloudWatch also need account-specific allowance/credit checks.
- No concurrency is reserved to avoid exhausting low new-account quotas. Do not publish many classes simultaneously during the first test; watch throttling and compute usage.
- Buckets, table and user pools have Retain policies. Deleting the stack does not remove those data resources. The bootstrap artifact bucket and ECR repository are outside the stack and also remain. Inventory them before deciding to delete anything; retained resources may continue costing money.

## Recovery and common errors

| Symptom | Action |
| --- | --- |
| `Unable to locate credentials`, expired session | Set AWS_PROFILE correctly; sign in again or configure the intended profile; run `aws sts get-caller-identity`. |
| Docker cannot connect | Start Docker Desktop, switch to Linux containers, run `docker info`. |
| ECR/CloudFront/service blocked by plan | Inspect the account's service eligibility. Do not silently upgrade to a paid plan; decide based on the cost implications. |
| CloudFormation fails | Read the first failed resource event, fix permissions/name/region/schema cause. Retained resources can survive rollback; do not blindly delete/recreate the stack. |
| Google `redirect_uri_mismatch` | In Google Console use the Cognito `/oauth2/idpresponse` URLs, not the app callbacks. Exact spelling/region matters. |
| Google says invite/password first | Complete native temporary-password login and verify the invited email matches Google. |
| `InvalidParameterException` during linking | Confirm you used the newly provisioned pool with mutable custom attributes, not an older pool with immutable school_id. |
| No email arrives | Check spam; check SES sandbox (recipient verified?) and the `svc: mailer` log line for the reason. |
| No recovery email | Check spam, verified email, enabled user, correct pool/client and daily sending quota. |
| Blank/unauthorized page | Re-run `web`, clear old local app sessions, inspect browser network API endpoint and token issuer. |
| Report PDF denied | Check results publication, state-machine execution, report-worker logs and the app's fresh presigned URL. |
| Model missing | Run `model`; inspect the actual model bucket pointer and scorer logs. |
| DiCE error/timeout | Inspect scorer and prediction logs; self-test validates loading, not a full real-class counterfactual job. |
| Provisioned throughput exceeded | Retry after load settles; reduce bulk activity. Changing capacity mode/raising capacity has cost implications. |

## What was verified here

- Frontend production build passed.
- All four Node Lambda entry points bundled successfully.
- 64 existing unit/store tests passed, including cross-pool isolation and school suspension checks.
- 10 new Google-link tests passed, including unverified/uninvited/disabled accounts, original subject preservation, roles and Workspace authority.
- All 91 generated GraphQL resolver mappings match the schema exactly.
- Python syntax checks passed; CloudFormation template checked with cfn-lint.
- Patch applicability checked against the inspected commit.

Not verified here: AWS resource creation, container build/runtime, real Google/Cognito redirects, email delivery, browser end-to-end flows, real report/prediction orchestration, billing eligibility or bulk performance. No AWS credentials were available, and Docker was unavailable in the execution environment. Run the acceptance checks above.

## Official references

- AWS Free Tier: https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/free-tier.html
- Cognito pricing: https://aws.amazon.com/cognito/pricing/
- Cognito quotas/email: https://docs.aws.amazon.com/cognito/latest/developerguide/quotas.html
- Google/social provider setup: https://docs.aws.amazon.com/cognito/latest/developerguide/tutorial-create-user-pool-social-idp.html
- Account linking: https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-identity-federation-consolidate-users.html
- AppSync quotas: https://docs.aws.amazon.com/general/latest/gr/appsync.html
- ECR pricing: https://aws.amazon.com/ecr/pricing/
- Google testing audience: https://support.google.com/cloud/answer/15549945
