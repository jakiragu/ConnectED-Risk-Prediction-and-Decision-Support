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

   Replace the output labels with their complete `https://...amazoncognito.com` values. These are **not** your CloudFront callback URLs. The CloudFormation client config already sets the app callbacks separately at `SiteUrl/auth/callback` and `SiteUrl/angaza/auth/callback`.
8. Save the client ID and client secret securely.

Then run:

```powershell
python deploy/aws/deploy.py google
```

The script prints the two exact Google redirect URIs again, prompts for the client ID and hidden secret, and updates both pool providers and both app clients. It uses a CloudFormation `NoEcho` parameter and deletes its temporary parameter file. Neither secret is written to the browser configuration. Later `deploy` runs preserve the existing Google parameters.

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

The default Cognito sender is `no-reply@verificationemail.com`. Check spam. The default sending quota is 50 messages per day per AWS account, shared across pools. SES/custom email setup is a later step for a wider rollout, not needed for a few live tests. Google itself does not send these reset emails.

Remember me was already implemented: checked uses localStorage; unchecked uses sessionStorage. The new OAuth flow preserves that choice. Both portals retain separate keys. Browser session restoration can sometimes restore sessionStorage tabs; this is not a strong shared-computer security boundary. Sign out explicitly on shared devices. App logout clears the app's session; it does not sign the person out of their Google account or implement global token revocation.

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
