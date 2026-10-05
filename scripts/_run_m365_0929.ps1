$k=[Environment]::GetEnvironmentVariable('ROOFOPS_ASIL_KEY','User')
if([string]::IsNullOrWhiteSpace($k)){
  Write-Output 'NO_ASIL_KEY'
} else {
  python C:\Users\Marks\projects\roofing-dashboard\scripts\m365_mail.py --bridge-key $k list-messages --folder Inbox
  Write-Output '---DRAFTS---'
  python C:\Users\Marks\projects\roofing-dashboard\scripts\m365_mail.py --bridge-key $k list-messages --folder Drafts
}
