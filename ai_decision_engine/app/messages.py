"""Generación de mensajes empáticos (plantillas deterministas; sin LLM ni envío)."""
from __future__ import annotations

from .schemas import Channel, DecisionRequest, DraftMessage, Strategy, StrategyCode

FOOTER = {
    "es": "\n\nEste es un mensaje informativo del banco. Si no deseas recibir estos avisos, responde BAJA.",
    "en": "\n\nThis is an informational message from the bank. To stop these notices, reply STOP.",
}

TEMPLATES = {
    ("es", StrategyCode.FRIENDLY_REMINDER): (
        "Recordatorio amable de tu pago",
        "Hola {name}, te escribimos para recordarte que tu cuota de {amount} vence el {due}. "
        "Gracias por mantener tus pagos al día. Si ya pagaste, ignora este aviso.",
    ),
    ("es", StrategyCode.PROACTIVE_SUPPORT): (
        "Estamos para apoyarte con tu próxima cuota",
        "Hola {name}, tu cuota de {amount} vence el {due}. Sabemos que a veces el mes se complica, "
        "y queremos ayudarte. Si lo necesitas, puedes consultar opciones como reprogramar tu fecha "
        "de pago (sujeto a evaluación). Responde a este mensaje y te orientamos sin compromiso.",
    ),
    ("es", StrategyCode.ADVISOR_OUTREACH): (
        "Queremos acompañarte con tu próxima cuota",
        "Hola {name}, gracias por confiar en nosotros. Tu cuota de {amount} vence el {due} y nos "
        "gustaría conversar contigo para entender cómo estás y ver juntos opciones que se adapten a "
        "ti (sujetas a evaluación). Un asesor puede contactarte en el horario que prefieras.",
    ),
    ("en", StrategyCode.FRIENDLY_REMINDER): (
        "A friendly payment reminder",
        "Hi {name}, just a reminder that your {amount} installment is due on {due}. "
        "Thanks for keeping your payments on track. If you already paid, please ignore this note.",
    ),
    ("en", StrategyCode.PROACTIVE_SUPPORT): (
        "We're here to help with your next installment",
        "Hi {name}, your {amount} installment is due on {due}. We know things can get tight, and we'd "
        "like to help. Options such as rescheduling your payment date may be available (subject to "
        "review). Reply to this message and we'll guide you, no commitment.",
    ),
    ("en", StrategyCode.ADVISOR_OUTREACH): (
        "We'd like to support you with your next installment",
        "Hi {name}, thank you for trusting us. Your {amount} installment is due on {due} and we'd love "
        "to talk with you to understand how you're doing and explore options that fit you (subject to "
        "review). An advisor can reach you at a time that suits you.",
    ),
}


def draft_message(req: DecisionRequest, strategy: Strategy) -> DraftMessage:
    lang = req.customer.language
    subject, body = TEMPLATES[(lang, strategy.code)]
    amount = f"{req.account.currency} {req.account.installment_amount:,.2f}"
    body = body.format(name=req.customer.first_name, amount=amount, due=req.account.next_due_date.isoformat())
    body += FOOTER[lang]
    uses_subject = strategy.channel in (Channel.EMAIL,)
    return DraftMessage(
        channel=strategy.channel, language=lang,
        subject=subject if uses_subject else None, body=body,
    )
