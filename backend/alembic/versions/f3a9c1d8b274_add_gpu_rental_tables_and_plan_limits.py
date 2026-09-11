"""add gpu rental tables and plan limits

Revision ID: f3a9c1d8b274
Revises: 904c066135ff
Create Date: 2026-09-09 12:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'f3a9c1d8b274'
down_revision: Union[str, Sequence[str], None] = '904c066135ff'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    # --- Extend plans with GPU rental limits ---
    # NOT NULL columns need a server_default here since the plans table
    # already has rows (FREE/PRO/MAX) — re-run scripts/seed.py right after
    # this migration to set the real per-plan values; these defaults are
    # deliberately the most restrictive (0 / false), never the most permissive.
    op.add_column('plans', sa.Column('gpu_max_concurrent_rentals', sa.Integer(), nullable=False, server_default='0'))
    op.add_column('plans', sa.Column('gpu_max_storage_gb', sa.Integer(), nullable=False, server_default='0'))
    op.add_column('plans', sa.Column('gpu_max_session_hours', sa.Integer(), nullable=True))
    op.add_column('plans', sa.Column('gpu_booking_allowed', sa.Boolean(), nullable=False, server_default='false'))
    op.add_column('plans', sa.Column('gpu_max_booking_days', sa.Integer(), nullable=False, server_default='0'))
    op.add_column('plans', sa.Column('gpu_rate_bps', sa.Integer(), nullable=False, server_default='10000'))

    # --- GPU catalog ---
    op.create_table(
        'gpu_types',
        sa.Column('slug', sa.String(length=50), nullable=False),
        sa.Column('display_name', sa.String(length=100), nullable=False),
        sa.Column('gpu_label', sa.String(length=100), nullable=False),
        sa.Column('aws_instance_type', sa.String(length=50), nullable=False),
        sa.Column('aws_region', sa.String(length=30), nullable=False),
        sa.Column('ami_id', sa.String(length=50), nullable=True),
        sa.Column('vram_gb', sa.Integer(), nullable=False),
        sa.Column('vcpu', sa.Integer(), nullable=False),
        sa.Column('ram_gb', sa.Integer(), nullable=False),
        sa.Column('price_micros_per_hour', sa.BigInteger(), nullable=False),
        sa.Column('aws_cost_micros_per_hour', sa.BigInteger(), nullable=False),
        sa.Column('max_runtime_hours', sa.Integer(), nullable=True),
        sa.Column('enabled', sa.Boolean(), nullable=False),
        sa.Column('id', sa.UUID(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(op.f('ix_gpu_types_slug'), 'gpu_types', ['slug'], unique=True)

    # --- SSH keys ---
    op.create_table(
        'ssh_keys',
        sa.Column('organization_id', sa.UUID(), nullable=False),
        sa.Column('created_by_user_id', sa.UUID(), nullable=False),
        sa.Column('label', sa.String(length=100), nullable=False),
        sa.Column('public_key', sa.String(length=4096), nullable=False),
        sa.Column('fingerprint', sa.String(length=100), nullable=False),
        sa.Column('aws_key_pair_name', sa.String(length=100), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('id', sa.UUID(), nullable=False),
        sa.ForeignKeyConstraint(['organization_id'], ['organizations.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(op.f('ix_ssh_keys_organization_id'), 'ssh_keys', ['organization_id'], unique=False)

    # --- GPU rentals ---
    op.create_table(
        'gpu_instances',
        sa.Column('organization_id', sa.UUID(), nullable=False),
        sa.Column('created_by_user_id', sa.UUID(), nullable=False),
        sa.Column('gpu_type_id', sa.UUID(), nullable=False),
        sa.Column('ssh_key_id', sa.UUID(), nullable=False),
        sa.Column(
            'status',
            sa.Enum(
                'PENDING_PAYMENT', 'PROVISIONING', 'RUNNING', 'STOPPING', 'STOPPED',
                'TERMINATING', 'TERMINATED', 'FAILED',
                name='gpuinstancestatus',
            ),
            nullable=False,
        ),
        sa.Column('payment_mode', sa.Enum('PAY_AS_YOU_GO', 'BOOKING', name='paymentmode'), nullable=False),
        sa.Column('booking_duration', sa.Enum('DAY', 'WEEK', name='bookingduration'), nullable=True),
        sa.Column('booking_expires_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('storage_gb', sa.Integer(), nullable=False),
        sa.Column('hourly_rate_micros', sa.BigInteger(), nullable=False),
        sa.Column('aws_instance_id', sa.String(length=50), nullable=True),
        sa.Column('public_ip', sa.String(length=64), nullable=True),
        sa.Column('started_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('stopped_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('terminated_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('provisioning_started_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('last_billed_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('total_charged_micros', sa.BigInteger(), nullable=False),
        sa.Column('error_detail', sa.String(length=500), nullable=True),
        sa.Column('id', sa.UUID(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(['organization_id'], ['organizations.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['gpu_type_id'], ['gpu_types.id']),
        sa.ForeignKeyConstraint(['ssh_key_id'], ['ssh_keys.id']),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(op.f('ix_gpu_instances_organization_id'), 'gpu_instances', ['organization_id'], unique=False)
    op.create_index(op.f('ix_gpu_instances_status'), 'gpu_instances', ['status'], unique=False)


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index(op.f('ix_gpu_instances_status'), table_name='gpu_instances')
    op.drop_index(op.f('ix_gpu_instances_organization_id'), table_name='gpu_instances')
    op.drop_table('gpu_instances')
    op.drop_index(op.f('ix_ssh_keys_organization_id'), table_name='ssh_keys')
    op.drop_table('ssh_keys')
    op.drop_index(op.f('ix_gpu_types_slug'), table_name='gpu_types')
    op.drop_table('gpu_types')

    op.drop_column('plans', 'gpu_rate_bps')
    op.drop_column('plans', 'gpu_max_booking_days')
    op.drop_column('plans', 'gpu_booking_allowed')
    op.drop_column('plans', 'gpu_max_session_hours')
    op.drop_column('plans', 'gpu_max_storage_gb')
    op.drop_column('plans', 'gpu_max_concurrent_rentals')

    # Enum types created implicitly by create_table above must be dropped
    # explicitly on downgrade (Postgres doesn't drop them with the table).
    sa.Enum(name='gpuinstancestatus').drop(op.get_bind(), checkfirst=True)
    sa.Enum(name='paymentmode').drop(op.get_bind(), checkfirst=True)
    sa.Enum(name='bookingduration').drop(op.get_bind(), checkfirst=True)
